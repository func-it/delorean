package bench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Langfuse is the few calls of the public API the bench needs: keep a
// dataset in step with the case files, and write scores. The traces — and
// with them the experiments, in v4 — travel by OpenTelemetry.
type Langfuse struct {
	BaseURL   string // https://cloud.langfuse.com
	PublicKey string
	SecretKey string
	HTTP      *http.Client
}

// Dataset is a subject's dataset in Langfuse.
type Dataset struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ProjectID string `json:"projectId"`
}

func (l *Langfuse) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(l.BaseURL, "/")+path, rd)
	if err != nil {
		return err
	}
	req.SetBasicAuth(l.PublicKey, l.SecretKey)
	req.Header.Set("Content-Type", "application/json")
	c := l.HTTP
	if c == nil {
		c = &http.Client{Timeout: 30 * time.Second}
	}
	rsp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer rsp.Body.Close()
	b, err := io.ReadAll(rsp.Body)
	if err != nil {
		return fmt.Errorf("langfuse %s %s: %w", method, path, err)
	}
	if rsp.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if rsp.StatusCode >= 300 {
		return fmt.Errorf("langfuse %s %s: %d %s", method, path, rsp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

var errNotFound = errors.New("not found")

// Dataset returns the subject's dataset, created on first use.
func (l *Langfuse) Dataset(ctx context.Context, name, description string) (Dataset, error) {
	var d Dataset
	err := l.do(ctx, http.MethodGet, "/api/public/v2/datasets/"+url.PathEscape(name), nil, &d)
	if errors.Is(err, errNotFound) {
		err = l.do(ctx, http.MethodPost, "/api/public/v2/datasets",
			map[string]any{"name": name, "description": description}, &d)
	}
	return d, err
}

type item struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// Sync makes the dataset hold exactly the case files: each case upserted
// under its id, and every item no file carries any more archived — kept with
// its past runs, left out of the next ones.
func (l *Langfuse) Sync(ctx context.Context, subject, description string, cases []Case) (Dataset, int, error) {
	d, err := l.Dataset(ctx, subject, description)
	if err != nil {
		return d, 0, err
	}
	keep := map[string]bool{}
	for _, c := range cases {
		id := itemID(subject, c.ID)
		keep[id] = true
		meta := map[string]any{"case": c.ID, "note": c.Note, "tags": c.Tags, "file": fmt.Sprintf("cases/%s/%s.json", subject, c.ID)}
		if err := l.do(ctx, http.MethodPost, "/api/public/dataset-items", map[string]any{
			"datasetName": subject, "id": id, "input": c.Input, "expectedOutput": c.Expect,
			"metadata": meta, "status": "ACTIVE",
		}, nil); err != nil {
			return d, 0, fmt.Errorf("case %s: %w", c.ID, err)
		}
	}
	archived := 0
	for page := 1; ; page++ {
		var rsp struct {
			Data []item `json:"data"`
			Meta struct {
				TotalPages int `json:"totalPages"`
			} `json:"meta"`
		}
		q := url.Values{"datasetName": {subject}, "page": {fmt.Sprint(page)}, "limit": {"100"}}
		if err := l.do(ctx, http.MethodGet, "/api/public/dataset-items?"+q.Encode(), nil, &rsp); err != nil {
			return d, archived, err
		}
		for _, it := range rsp.Data {
			if keep[it.ID] || it.Status == "ARCHIVED" {
				continue
			}
			if err := l.do(ctx, http.MethodPost, "/api/public/dataset-items", map[string]any{
				"datasetName": subject, "id": it.ID, "status": "ARCHIVED",
			}, nil); err != nil {
				return d, archived, err
			}
			archived++
		}
		if page >= rsp.Meta.TotalPages {
			break
		}
	}
	return d, archived, nil
}

// Score is one score written through the public API: on a trace (one case)
// or on an experiment (DatasetRunID, the experiment id in v4).
type Score struct {
	Name         string
	Value        float64
	TraceID      string
	DatasetRunID string
	Comment      string
}

func (l *Langfuse) Score(ctx context.Context, sc Score) error {
	body := map[string]any{"name": sc.Name, "value": sc.Value, "dataType": "NUMERIC", "environment": "bench"}
	if sc.TraceID != "" {
		body["traceId"] = sc.TraceID
	}
	if sc.DatasetRunID != "" {
		body["datasetRunId"] = sc.DatasetRunID
	}
	if sc.Comment != "" {
		body["comment"] = sc.Comment
	}
	return l.do(ctx, http.MethodPost, "/api/public/scores", body, nil)
}

// RunURL is the page of one experiment, as a person opens it (v4).
func (l *Langfuse) RunURL(d Dataset, runID string) string {
	return fmt.Sprintf("%s/project/%s/experiments/results?baseline=%s", strings.TrimRight(l.BaseURL, "/"), d.ProjectID, runID)
}

// DatasetURL is where the runs of a dataset are compared.
func (l *Langfuse) DatasetURL(d Dataset) string {
	return fmt.Sprintf("%s/project/%s/datasets/%s", strings.TrimRight(l.BaseURL, "/"), d.ProjectID, d.ID)
}
