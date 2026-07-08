<p align="center">
  <img src="logo.png" alt="ClawBridge" width="140">
</p>

# ClawBridge

Control Claude Code from your mobile browser — no desktop, no SSH.

A lightweight web interface for running Claude Code on Android via Termux.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/basharbhassan336699-cell/ClawBridge/main/install.sh | bash
```

## Manual Install

```bash
git clone https://github.com/basharbhassan336699-cell/ClawBridge.git
cd ClawBridge
bash install.sh
```

## Usage

```bash
clawbridge
```

Open in browser:
- Same phone: http://localhost:7979
- Network: http://<your-ip>:7979

## Requirements

- Android 8+ aarch64
- Termux from F-Droid
- Node.js
- API key (Anthropic / OpenRouter / Aerolink)

## Features

- Clean, responsive mobile-first UI (RTL-ready)
- Real-time streaming (SSE)
- Send button that appears as you type
- File upload — any type, up to 300 MB
- Configure any platform (Base URL + API key)
- Model discovery — list the models available on your platform
- Works with Anthropic and OpenAI-compatible endpoints (OpenRouter, Aerolink, …)

## License

MIT
