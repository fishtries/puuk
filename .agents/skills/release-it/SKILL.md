---
name: release-it
description: Apply Michael T. Nygard-inspired production reliability rules when designing failure handling, timeouts, retries, circuit breakers, observability, or deployment behavior. Use for SFTP integration, streaming, background jobs, retry logic, and Qdrant integration.
license: MIT
---

# Release It! Skill

Use this skill when a task involves production reliability for integration points: SFTP connections, HTTP streaming with Range support, background workers, retry logic with backoff, Qdrant vector operations, or operational readiness of network-facing services.

**Do not use** for simple CRUD operations, local code changes, or standard FastAPI route handlers without external dependencies.

Before making design or code decisions, read and apply [release-it.mini.md](release-it.mini.md). Use [release-it.md](release-it.md) only as a deeper reference when the mini rules are not enough for the current production-reliability tradeoff.
