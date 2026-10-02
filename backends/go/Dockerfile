# The Go implementation of the API: a static binary on distroless, as a
# non-root user. The tokenizer's vocabulary is compiled in: nothing is
# fetched at run time but the models.
#   docker build -t delorean-go .
#   docker run -p 24791:24791 -e OPENROUTER_API_KEY delorean-go
#   docker run -p 24791:24791 -e ENGINES=fake delorean-go
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/delorean ./cmd/delorean

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/delorean /usr/local/bin/delorean
ENV PORT=24791 ENGINES=live
EXPOSE 24791
USER nonroot
ENTRYPOINT ["/usr/local/bin/delorean"]
CMD ["serve"]
