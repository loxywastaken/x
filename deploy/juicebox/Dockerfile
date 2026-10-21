FROM golang:1.25-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /source
RUN git init && git remote add origin https://github.com/juicebox-systems/juicebox-software-realm.git && git fetch --depth=1 origin 2e485aac584a6c9ada1fb9f156dc4d7cad3ab338 && git checkout --detach FETCH_HEAD
COPY postgres.patch /tmp/postgres.patch
RUN git apply /tmp/postgres.patch
COPY postgresStore.go records/postgresStore.go
RUN CGO_ENABLED=0 go build -trimpath -o /realm ./cmd/jb-sw-realm
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /realm /realm
EXPOSE 8580
ENTRYPOINT ["/realm"]
