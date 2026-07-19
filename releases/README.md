# aiDimag IDE Extensions

Download and install the aiDimag extensions for your IDE.

## VS Code Extension

**File:** `aidimag-vscode-1.0.0.vsix`

### Installation

1. Download `aidimag-vscode-1.0.0.vsix`
2. Open VS Code
3. Go to Extensions view (Ctrl+Shift+X / Cmd+Shift+X)
4. Click the "..." menu → "Install from VSIX..."
5. Select the downloaded `.vsix` file

Or via command line:
```bash
code --install-extension aidimag-vscode-1.0.0.vsix
```

### Features

- 🧠 Memory Explorer panel with tree view
- 📊 Memory detail view with status indicators
- ⚡ Quick commands for common operations
- 🔄 Auto-sync team memory
- 📝 Knowledge inbox watcher
- 🎨 Syntax highlighting for memory status

## IntelliJ Plugin

**File:** `aidimag-intellij-plugin-1.0.0.zip`

### Installation

1. Download `aidimag-intellij-plugin-1.0.0.zip`
2. Open IntelliJ IDEA
3. Go to Settings/Preferences → Plugins
4. Click the gear icon ⚙️ → "Install Plugin from Disk..."
5. Select the downloaded `.zip` file
6. Restart IntelliJ IDEA

### Features

- 🧠 Embedded dashboard tool window
- 🔧 CLI action shortcuts
- 🎯 Context menu integration
- 📊 Memory status indicators

## Requirements

Both extensions require:
- `dim` CLI installed: `npm install -g aidimag`
- Node.js 18 or higher
- An initialized aiDimag repository (`.aidimag/` directory)

## Documentation

For full documentation, visit: https://anup-khanal.github.io/aidimag/

## License

Elastic License 2.0 - Free for teams of 10 or fewer users.
