# syntax=docker/dockerfile:1
# The Python implementation of the API: the locked dependencies in a virtual
# environment, the tokenizer's vocabulary fetched at build time and checked
# against its pinned SHA-256, the shared prompts, a non-root user. Nothing is
# fetched at run time but the models. Built from the repository's root, for
# prompts/:
#   docker build -f quoters/python/Dockerfile -t delorean-python .
#   docker run -p 24792:24792 -e OPENROUTER_API_KEY delorean-python
#   docker run -p 24792:24792 -e ENGINES=fake delorean-python

FROM ghcr.io/astral-sh/uv:0.12.22 AS uv

FROM python:3.14-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src
# the dependencies first, cached apart from the sources
COPY quoters/python/pyproject.toml quoters/python/uv.lock quoters/python/.python-version ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY quoters/python/README.md ./
COPY quoters/python/src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-editable
RUN TIKTOKEN_CACHE_DIR=/app/tiktoken /app/.venv/bin/delorean tokenizer

FROM python:3.14-slim
WORKDIR /app
COPY --from=build /app/.venv ./.venv
COPY --from=build /app/tiktoken ./tiktoken
# the prompt files, and nothing else of prompts/ (a Go module too)
COPY prompts/guard.json prompts/parse.json prompts/parse-films.json prompts/identify.json prompts/judge.json ./prompts/
ARG VERSION=dev
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PORT=24792 \
    ENGINES=live \
    PROMPTS_DIR=/app/prompts \
    TIKTOKEN_CACHE_DIR=/app/tiktoken \
    DELOREAN_VERSION=${VERSION}
EXPOSE 24792
# a numeric user, as every quoter's image: no account to create
USER 65532:65532
ENTRYPOINT ["delorean"]
CMD ["serve"]
