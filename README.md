# ViewerEyes

ViewerEyes shows who is watching your Discord stream directly in calls and server voice channel member lists.

## Features

- Viewer indicator on Discord call tiles.
- Viewer indicator in server voice channel member lists.
- Compact list of current stream viewers.
- Pagination for larger viewer lists.
- Theme-aware interface.

## Requirements

Custom Vencord plugins require a Vencord installation built from source.

Read the official Vencord guides before continuing:

- https://docs.vencord.dev/installing/
- https://docs.vencord.dev/installing/custom-plugins/

Install Git, Node.js and pnpm. Verify that they are available:

```text
git --version
node --version
pnpm --version
```

> Already have Vencord built from source? Skip the Vencord clone step and install the plugin inside your existing `src/userplugins` folder.

## Installation

### Windows (PowerShell)

Open PowerShell and run:

```powershell
Set-Location $HOME

git clone https://github.com/Vendicated/Vencord.git
Set-Location .\Vencord

pnpm install --frozen-lockfile

New-Item -ItemType Directory -Path .\src\userplugins -Force | Out-Null
Set-Location .\src\userplugins

git clone https://github.com/fevegit/ViewerEyes.git viewerEyes

Set-Location ..\..

pnpm build
pnpm inject
```

`pnpm inject` opens the Vencord installer. Select the Discord installation you want to patch.

After injection:

1. Fully close Discord, including the system tray process.
2. Start Discord again.
3. Open **Settings -> Vencord -> Plugins**.
4. Enable **ViewerEyes**.

The final plugin path should be:

```text
%USERPROFILE%\Vencord\src\userplugins\viewerEyes\
```

### Linux (Bash)

Open a terminal and run:

```bash
cd "$HOME"

git clone https://github.com/Vendicated/Vencord.git
cd Vencord

pnpm install --frozen-lockfile

mkdir -p src/userplugins
cd src/userplugins

git clone https://github.com/fevegit/ViewerEyes.git viewerEyes

cd ../..

pnpm build
pnpm inject
```

`pnpm inject` opens the Vencord installer. Select the Discord installation you want to patch.

After injection:

1. Fully close Discord.
2. Start Discord again.
3. Open **Settings -> Vencord -> Plugins**.
4. Enable **ViewerEyes**.

The final plugin path should be:

```text
$HOME/Vencord/src/userplugins/viewerEyes/
```

For Vesktop or another non-standard Discord client, follow the official Vencord installation guide for that client and keep the plugin inside the same Vencord source tree.

## Updating

### Windows (PowerShell)

```powershell
Set-Location "$HOME\Vencord\src\userplugins\viewerEyes"
git pull --ff-only

Set-Location "$HOME\Vencord"
pnpm build
pnpm inject
```

Fully restart Discord afterwards.

### Linux (Bash)

```bash
cd "$HOME/Vencord/src/userplugins/viewerEyes"
git pull --ff-only

cd "$HOME/Vencord"
pnpm build
pnpm inject
```

Fully restart Discord afterwards.

## Uninstalling

Disable the plugin in Vencord before removing its folder.

### Windows (PowerShell)

```powershell
Set-Location "$HOME\Vencord"

Remove-Item -LiteralPath ".\src\userplugins\viewerEyes" -Recurse -Force

pnpm build
pnpm inject
```

### Linux (Bash)

```bash
cd "$HOME/Vencord"

rm -rf -- "src/userplugins/viewerEyes"

pnpm build
pnpm inject
```

Fully restart Discord after rebuilding.

## Troubleshooting

### The plugin does not appear

Check that the plugin folder is exactly:

```text
Vencord/src/userplugins/viewerEyes/
```

The folder itself must directly contain the plugin source files such as `index.ts` or `index.tsx`.

### `pnpm` is not recognized or not found

Install pnpm and reopen the terminal. Then verify it with:

```text
pnpm --version
```

### The build fails after a Vencord update

Update both Vencord and this plugin, reinstall dependencies and rebuild:

```text
git pull
pnpm install --frozen-lockfile
pnpm build
```

## Notes

- This is an unofficial custom userplugin and is not supported by the Vencord team.
- Custom plugins require rebuilding Vencord whenever their source changes.
- Use `src/userplugins`; do not copy the plugin into `src/plugins`.
- This repository contains only plugin source code and public documentation.

<!-- acknowledgements:start -->
## Acknowledgements

ViewerEyes was inspired by [WhosWatching](https://github.com/fres621/vencord-whos-watching) by **fres621** and its contributors.

I used the original plugin and liked being able to see who was watching my stream, but I wanted that information to be more visible throughout Discord. ViewerEyes was created as an independent implementation with viewer indicators on call tiles and voice-channel member lists, plus a dedicated viewer panel and additional interface controls.

Many thanks to fres621 and the original contributors for their work and for inspiring this project.
<!-- acknowledgements:end -->

## License

GPL-3.0-or-later.
