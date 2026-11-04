# Recovery review

The live design now uses one recovery reviewer for troubleshooting and proposed stopping decisions. See [the current architecture and validation contract](unified-recovery-review.md).

The legacy specialist tool and checkpoint names remain compatible. Advice is read-only, optional to report on, and cannot force an application outcome. The applying agent owns browser actions; the code owns state, permissions, evidence freshness, approval and receipt boundaries. There is no separate AI stopping supervisor. Process supervision remains active.
