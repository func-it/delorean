# The Go implementation of the API: a static binary on distroless, as a
# non-root user. The tokenizer's vocabulary and the prompts are compiled in:
# nothing is fetched at run time but the models. Built from the repository's
# root, for the prompts module (prompts/), which go.mod replaces by its path:
#   docker build -f quoters/go/Dockerfile -t delorean-go .
#   docker run -p 24791:24791 -e OPENROUTER_API_KEY delorean-go
#   docker run -p 24791:24791 -e ENGINES=fake delorean-go
FROM golang:1.26-alpine AS build
# the repository's layout, so that ../../prompts resolves
WORKDIR /src/quoters/go
COPY prompts /src/prompts
COPY quoters/go/go.mod quoters/go/go.sum ./
RUN go mod download
COPY quoters/go/cmd ./cmd
COPY quoters/go/internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/delorean ./cmd/delorean

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/delorean /usr/local/bin/delorean
ENV PORT=24791 ENGINES=live
EXPOSE 24791
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/delorean"]
CMD ["serve"]
