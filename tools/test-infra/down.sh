#!/usr/bin/env bash
docker rm -f cap-test-pg cap-test-vault cap-test-garage >/dev/null 2>&1 || true
