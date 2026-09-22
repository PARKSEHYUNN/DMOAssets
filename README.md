# DMOAssets

[한국어](README_ko.md)

Asset viewer and extractor for the Digimon Masters Online client.

> **Status: in development.** Nothing is usable yet.

## Features (planned)

- **GUI** (portable Windows EXE): point it at your DMO install folder to browse every file in the `.hf`/`.pf` packs, preview models and UI images, and extract them.
- **CLI** (single EXE): extract packs and convert models from the command line.
- **Model export**: GLB (glTF 2.0) and binary FBX, with skeletons, skinning and animations.
- **Image preview**: DDS (DXT1/3/5), TGA, PNG, BMP, JPG.

## Supported clients

| Client | Status |
|---|---|
| KDMO (Korea, MoveInteractive) | Target |
| GDMO (Global, Steam) | Target |
| Old GDMO client (index version 0x10, private servers) | Not supported |

## Usage (planned)

```
dmoassets list    <DMO folder> [--filter <pattern>]
dmoassets extract <DMO folder> [--filter <pattern>] [-o <output>]
dmoassets convert <.nif or .kfm> -f glb|fbx [-o <output>]
```

Close the game before running. KDMO locks its pack files while it is running.

## Development

- Node.js 24, ESM, JavaScript with JSDoc types, no build step
- Electron for the GUI, Node SEA for the CLI
- Tests: `npm test` (`node --test`)

Format specification (Korean): [docs/FORMAT.md](docs/FORMAT.md).

## License

The source code is licensed under the [MIT License](LICENSE). The license covers this project's code only, not any game assets.

## Disclaimer

This is an unofficial fan project. It is not affiliated with or endorsed by Bandai Namco, MoveInteractive or any other operator of Digimon Masters Online. The game assets are copyrighted by their owners. The tool only reads files from a client you have installed, and it never modifies them. Use extracted assets for personal study only and do not redistribute them.
