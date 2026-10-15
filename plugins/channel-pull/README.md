# channel-pull (deprecated)

Replaced by [`bridge`](../bridge/README.md) (+ [`bridge-format`](../bridge-format/hooks/register.ts)), which does the same Telegram → desktop-app delivery and adds a status band and `/bridge status|doctor`.

To switch, uninstall this and `channel-pull-format`, refresh the marketplace, then install `bridge` and `bridge-format`. Don't run both at once: the two pollers keep cutting each other's long-poll short (`bridge` backs off and its band says so).

```bash
claude plugin uninstall channel-pull@claude-mobile-bridge
```

```bash
claude plugin uninstall channel-pull-format@claude-mobile-bridge
```

```bash
claude plugin marketplace update claude-mobile-bridge
```

```bash
claude plugin install bridge@claude-mobile-bridge
```

```bash
claude plugin install bridge-format@claude-mobile-bridge
```
