<p align="center">
  <img src="https://github.com/nuhmanpk/matricx/blob/main/assets/logo.png?raw=true" alt="Matricx Logo" width="120"/>
</p>

<h1 align="center">Matricx</h1>
<p align="center"><b>Your system, in full color.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/matricx"><img src="https://img.shields.io/npm/v/matricx?color=blue&label=npm%20version" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/matricx"><img src="https://img.shields.io/npm/dt/matricx.svg?color=green&label=downloads" alt="npm downloads"></a>
  <a href="https://github.com/nuhmanpk/matricx/stargazers"><img src="https://img.shields.io/github/stars/nuhmanpk/matricx?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/nuhmanpk/matricx/blob/main/LICENSE"><img src="https://img.shields.io/github/license/nuhmanpk/matricx" alt="license"></a>
</p>

```bash
npx matricx -y
```
---

## 🚀 What is Matricx?

**Matricx** is a modern, terminal-based dashboard that shows real-time system metrics with a clean and colorful TUI.  
Think of it as a fresh upgrade over `top` or `htop`, but minimal and cross-platform.

---

## 🎯 Use Cases

- Keep an eye on **CPU, memory, and network** usage.
- Quickly view **top processes** hogging resources.
- Get a glance at running **system services**.
- Use it during **development, servers, or debugging** sessions.
- Share JSON snapshots of system metrics with `--json`.

---

## 📦 Installation & Usage

No installation required! Just run it directly with **npx**:

```bash
npx matricx
```

Run without prompts (useful for scripts):

```bash
npx matricx -y
```

### Advanced CLI Options

You can append CLI arguments to run advanced modes:

```bash
# Output system specs as raw JSON (useful for cron jobs/scripts)
npx matricx --json

# Override the default 1000ms dashboard polling interval
npx matricx --interval 500

# Open directly into a specific view
npx matricx --net
```

---

## 🛠️ Local Development

To run the project locally from the repository:

1. Clone the repository and navigate into it.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the dashboard:
   ```bash
   npm run dev
   ```

*Tip: You can also start specific views by using `npm run cpu`, `npm run net`, etc. Check out `package.json` for all available scripts!*

<p align="center"> <img src="https://github.com/nuhmanpk/matricx/blob/main/assets/demo.png?raw=true" alt="Matricx Screenshot"/> </p>

Made with ❤️ by [Nuhman](https://github.com/nuhmanpk). Happy Coding 🚀