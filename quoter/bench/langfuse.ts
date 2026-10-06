/**
 * The few calls of Langfuse's public API a bench needs: keep a dataset in step with the case files, and write
 * scores. The traces (and with them the experiments, in Langfuse v4) travel by OpenTelemetry, as the service's do
 * (src/telemetry/). Langfuse keeps the runs for comparison; it does not decide them: the bench computes its own
 * results.
 */
import type { Langfuse } from '../src/telemetry/langfuse.ts';
import type { Case } from './cases.ts';

/** A subject's dataset in Langfuse. */
export interface Dataset {
  id: string;
  name: string;
  projectId?: string;
}

/** One score written through the public API: on a trace (one case) or on an experiment (`datasetRunId`). */
export interface ScoreBody {
  name: string;
  value: number;
  traceId?: string;
  datasetRunId?: string;
  comment?: string;
}

/** A case's id in Langfuse, where item ids are unique across the whole project: two subjects may both have a case "x". */
export function itemId(subject: string, caseId: string): string {
  return `${subject}:${caseId}`;
}

class NotFound extends Error {
  override name = 'NotFound';
}

export class LangfuseApi {
  readonly #project: Langfuse;
  readonly #fetch: typeof globalThis.fetch;

  constructor(project: Langfuse, fetch: typeof globalThis.fetch = globalThis.fetch) {
    this.#project = project;
    this.#fetch = fetch;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const { baseUrl, publicKey, secretKey } = this.#project;
    const response = await this.#fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (response.status === 404) throw new NotFound(`langfuse ${method} ${path}: not found`);
    if (!response.ok) throw new Error(`langfuse ${method} ${path}: ${response.status} ${text.trim()}`);
    return text === '' ? undefined : (JSON.parse(text) as T);
  }

  /** The subject's dataset, created on first use. */
  async dataset(name: string, description: string): Promise<Dataset> {
    try {
      return (await this.#call<Dataset>('GET', `/api/public/v2/datasets/${encodeURIComponent(name)}`)) as Dataset;
    } catch (error) {
      if (!(error instanceof NotFound)) throw error;
      return (await this.#call<Dataset>('POST', '/api/public/v2/datasets', { name, description })) as Dataset;
    }
  }

  /**
   * Makes the dataset hold exactly the case files: each case upserted under its id, and every item no file carries
   * any more archived: kept with its past runs, left out of the next ones.
   */
  async sync(
    subject: string,
    description: string,
    cases: readonly Case[],
  ): Promise<{ dataset: Dataset; archived: number }> {
    const dataset = await this.dataset(subject, description);
    const keep = new Set<string>();
    for (const c of cases) {
      const id = itemId(subject, c.id);
      keep.add(id);
      try {
        await this.#call('POST', '/api/public/dataset-items', {
          datasetName: subject,
          id,
          input: c.input,
          expectedOutput: c.expect,
          metadata: { case: c.id, note: c.note, tags: c.tags ?? [], file: `cases/${subject}/${c.id}.json` },
          status: 'ACTIVE',
        });
      } catch (error) {
        throw new Error(`case ${c.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    let archived = 0;
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ datasetName: subject, page: String(page), limit: '100' });
      const rsp = await this.#call<{ data: { id: string; status: string }[]; meta: { totalPages: number } }>(
        'GET',
        `/api/public/dataset-items?${query.toString()}`,
      );
      for (const item of rsp?.data ?? []) {
        if (keep.has(item.id) || item.status === 'ARCHIVED') continue;
        await this.#call('POST', '/api/public/dataset-items', {
          datasetName: subject,
          id: item.id,
          status: 'ARCHIVED',
        });
        archived++;
      }
      if (page >= (rsp?.meta.totalPages ?? 0)) break;
    }
    return { dataset, archived };
  }

  async score(score: ScoreBody): Promise<void> {
    await this.#call('POST', '/api/public/scores', {
      name: score.name,
      value: score.value,
      dataType: 'NUMERIC',
      environment: 'bench',
      ...(score.traceId && { traceId: score.traceId }),
      ...(score.datasetRunId && { datasetRunId: score.datasetRunId }),
      ...(score.comment && { comment: score.comment }),
    });
  }

  /** The page of one experiment, as a person opens it (v4). */
  runUrl(dataset: Dataset, runId: string): string {
    return `${this.#base()}/project/${dataset.projectId ?? ''}/experiments/results?baseline=${runId}`;
  }

  /** Where the runs of a dataset are compared. */
  datasetUrl(dataset: Dataset): string {
    return `${this.#base()}/project/${dataset.projectId ?? ''}/datasets/${dataset.id}`;
  }

  #base(): string {
    return this.#project.baseUrl.replace(/\/+$/, '');
  }
}
