# ViewerEyes

ViewerEyes is a custom Vencord userplugin that shows who is watching your Discord stream directly in calls and server voice channel member lists.

## Features

- Viewer indicator on Discord call tiles.
- Viewer indicator in server voice channel member lists.
- Compact list of current stream viewers.
- Pagination for larger viewer lists.
- Theme-aware interface.
- Optional demo controls for testing the viewer UI.

## Requirements

Custom Vencord plugins require a Vencord installation built from source.

Follow the official Vencord guides first:

- https://docs.vencord.dev/installing/
- https://docs.vencord.dev/installing/custom-plugins/

You need Git, Node.js and pnpm available in your terminal.

## Manual installation

Open a terminal inside Vencord/src/userplugins and run:

`sh
git clone https://github.com/fevegit/ViewerEyes.git viewerEyes
`

Return to the Vencord root folder:

`sh
cd ../../
pnpm build
pnpm inject
`

Fully restart Discord, then open **Settings → Vencord → Plugins** and enable **ViewerEyes**.

The plugin must be located at:

`	ext
Vencord/src/userplugins/viewerEyes/
`

## Updating

Inside Vencord/src/userplugins/viewerEyes, run:

`sh
git pull
`

Then rebuild from the Vencord root:

`sh
pnpm build
pnpm inject
`

Fully restart Discord afterwards.

## Uninstalling

1. Disable ViewerEyes in Vencord.
2. Delete Vencord/src/userplugins/viewerEyes.
3. Run pnpm build and pnpm inject again.
4. Restart Discord.

## Notes

- ViewerEyes is an unofficial custom userplugin and is not supported by the Vencord team.
- Custom plugins require rebuilding Vencord whenever their source changes.
- This repository contains only the plugin source and public installation documentation.

## License

GPL-3.0-or-later.