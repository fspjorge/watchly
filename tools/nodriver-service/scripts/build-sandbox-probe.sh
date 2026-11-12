#!/bin/sh
set -eu
set +x
: "${IMAGE_URI:?Cloud Build did not provide IMAGE_URI}"

docker build --tag watchly-nodriver-render:cloud-build-test --file Dockerfile .
docker build --tag "$IMAGE_URI" --file Dockerfile.sandbox-probe .
docker push "$IMAGE_URI"
