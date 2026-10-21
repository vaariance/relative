ARG RUST_IMAGE=rust:1.90.0-bookworm
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot
FROM ${RUST_IMAGE} AS build
ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} TZ=UTC CARGO_PROFILE_RELEASE_DEBUG=0
WORKDIR /workspace
COPY apps/cox-publisher/native/Cargo.toml apps/cox-publisher/native/Cargo.lock apps/cox-publisher/native/
COPY apps/cox-publisher/native/src apps/cox-publisher/native/src
COPY packages/cox/programs/cox/Cargo.toml packages/cox/programs/cox/
COPY packages/cox/programs/cox/src packages/cox/programs/cox/src
COPY packages/cox/crates/math/Cargo.toml packages/cox/crates/math/
COPY packages/cox/crates/math/src packages/cox/crates/math/src
COPY packages/cox-epoch/Cargo.toml packages/cox-epoch/
COPY packages/cox-epoch/src packages/cox-epoch/src
COPY packages/cox-epoch/programs/epoch/Cargo.toml packages/cox-epoch/programs/epoch/
COPY packages/cox-epoch/programs/epoch/src packages/cox-epoch/programs/epoch/src
COPY packages/cox-methodology/rust/Cargo.toml packages/cox-methodology/rust/
COPY packages/cox-methodology/rust/src packages/cox-methodology/rust/src
RUN rustc --version | grep '^rustc 1.90.0 ' && cargo build --release --locked --manifest-path apps/cox-publisher/native/Cargo.toml

FROM scratch AS artifact
COPY --from=build /workspace/apps/cox-publisher/native/target/release/relative-publisher /relative-publisher

FROM ${RUNTIME_IMAGE} AS runtime
COPY --from=build /workspace/apps/cox-publisher/native/target/release/relative-publisher /usr/local/bin/relative-publisher
COPY --from=build /usr/lib/x86_64-linux-gnu/libssl.so.3 /usr/lib/x86_64-linux-gnu/libssl.so.3
COPY --from=build /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 65532:65532
WORKDIR /var/lib/cox-publisher
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENTRYPOINT ["/usr/local/bin/relative-publisher"]
CMD ["run", "--config", "/etc/cox-publisher/native.json"]
