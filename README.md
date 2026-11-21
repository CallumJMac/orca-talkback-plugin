<div align="center">
  <h1>🗣️ Talkback for Orca</h1>
  <p><strong>The Orca plugin half of <a href="https://github.com/CallumJMac/orca-talkback">orca-talkback</a>: hear your coding agents talk back.</strong></p>
</div>

<p align="center">
  <a href="https://github.com/stablyai/orca"><img src="https://img.shields.io/badge/Orca-1.4.248%2B-orange?style=for-the-badge" alt="Orca 1.4.248 or newer"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-green?style=for-the-badge" alt="Apache 2.0"></a>
</p>

---

This plugin tells the local [orca-talkback](https://github.com/CallumJMac/orca-talkback) daemon which workspace you are looking at and when your agents start and finish. The daemon then speaks a short summary of each finished reply on your Mac, and stops when you talk over it.

**The plugin does nothing on its own.** Set up the daemon first: [orca-talkback quick start](https://github.com/CallumJMac/orca-talkback#quick-start).

## Install

```bash
orca plugin install CallumJMac/orca-talkback-plugin
# Orca prints a fingerprint for the access below; approve exactly that:
orca plugin install CallumJMac/orca-talkback-plugin --approve ap1-<fingerprint Orca printed>
```

It is also submitted to Orca's community catalog; once listed, you can install **Talkback** from **Settings, Plugins** after adding the community marketplace (`https://github.com/stablyai/orca-community-plugins.git`, ref `main`).

## What it can access

| Capability | Why |
|---|---|
| `workspace:read` | To know which workspace is on screen (`workspace.changed`) |
| `agent:read` | To know when an agent starts or finishes (`agent.status.changed`) |

It forwards those two events, unchanged and in order, to `http://127.0.0.1:47823` on your own machine. It sends nothing anywhere else, reads no files and runs no commands. If the daemon is not running, it logs that at most once a minute and Orca carries on as normal.

## Development

```bash
orca plugin types .      # generate the TypeScript types into .orca/
orca plugin test .
orca plugin validate .
```

Licensed under the [Apache License 2.0](LICENSE).
