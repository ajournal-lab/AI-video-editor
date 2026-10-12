# Third-party licences

ReelSmith itself is proprietary (see `LICENSE`). This file lists every third-party component it ships with,
installs or calls, and that component's licence. Last checked: 2026-10-09.

There are three groups:
- **Vendored:** the files are in this repository, with their licence text next to them.
- **Installed by `setup.ps1`:** downloaded on each computer, never committed. Each keeps its own licence files.
- **External programs:** run as separate processes. Their code is not linked into ReelSmith.

## 1. Vendored in this repository

| Component | Where | Licence | Licence text |
|---|---|---|---|
| Bebas Neue (font) | `public/fonts/BebasNeue.ttf` | SIL Open Font License 1.1 | `public/fonts/OFL-BebasNeue.txt` |
| Inter (font) | `public/fonts/Inter-*.ttf` | SIL Open Font License 1.1 | `public/fonts/OFL-Inter.txt` |
| Montserrat (font) | `public/fonts/Montserrat-ExtraBold.ttf` | SIL Open Font License 1.1 | `public/fonts/OFL-Montserrat.txt` |
| Playfair Display (font) | `public/fonts/PlayfairDisplay-Bold.ttf`, `PlayfairDisplay-Italic.ttf` (variable, from google/fonts) | SIL Open Font License 1.1 | `public/fonts/OFL-PlayfairDisplay.txt` |
| Permanent Marker (font, Font Diner) | `public/fonts/PermanentMarker.ttf` | Apache-2.0 | `public/fonts/LICENSE-PermanentMarker.txt` |
| shadcn/ui components (generated with the shadcn CLI, then edited) | `src/components/ui/*`, `cn()` in `src/lib/utils.ts` | MIT | `src/components/ui/LICENSE-shadcn-ui.md` |

The sample project media (`public/sample/`) was made for this project. It is a text-to-speech narration of a
generic productivity script, its transcript, and a ReelSmith render of gradient cards with text. It shows no people.

## 2. Installed by `setup.ps1` (not in the repository)

| Component | What ReelSmith uses it for | Licence | How it is installed |
|---|---|---|---|
| [video-use](https://github.com/browser-use/video-use) (Browser Use) | Claude Code skill: editing helpers | MIT | `git clone` into `REEL_STUDIO_DIR\.claude\skills\video-use`, pinned commit. Its `LICENSE` comes with the clone |
| [HyperFrames](https://github.com/heygen-com/hyperframes) (HeyGen) | Optional animation engine that video-use runs with `npx hyperframes` | Apache-2.0 | npm cache (`npx --yes hyperframes`) |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Local transcription | MIT | pip (worker venv) |
| Whisper model weights (OpenAI Whisper, CTranslate2 conversion [Systran/faster-whisper-*](https://huggingface.co/Systran)) | Speech-to-text model | MIT | Hugging Face cache, on first use or by setup |
| [Real-ESRGAN ncnn Vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) (binary) | Optional AI upscale | MIT | release zip into `REEL_STUDIO_DIR\tools\realesrgan` |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) model weights (`realesrgan-x4plus`, in the same zip) | Upscale model | BSD-3-Clause | same zip |
| [ncnn](https://github.com/Tencent/ncnn) (built into the Real-ESRGAN binary) | Inference runtime | BSD-3-Clause | same zip |
| [RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting) model `rvm_mobilenetv3_fp32.onnx` | Background removal (`worker/matte.py`) | **GPL-3.0** | release download into `worker\models\` (gitignored) |

**About RobustVideoMatting:** its weights are GPL-3.0. ReelSmith contains none of RVM's code. `worker/matte.py` is our
own code, and it loads the ONNX file at runtime with onnxruntime (MIT). The weights are downloaded on each user's computer
and are never committed or distributed with ReelSmith. If you ever bundle the model file in a distribution, the GPL-3.0
terms apply to that distribution. Background removal is optional: delete the model to drop it.

### Python packages (`worker/requirements.txt` + video-use helpers; pip into `worker\.venv`)

| Package | Licence |
|---|---|
| faster-whisper | MIT |
| ctranslate2 (via faster-whisper) | MIT |
| PyAV `av` (via faster-whisper) | BSD-3-Clause (bundled FFmpeg libraries: LGPL-2.1+) |
| tokenizers, huggingface-hub (via faster-whisper) | Apache-2.0 |
| onnxruntime | MIT |
| psycopg, psycopg-binary | LGPL-3.0 (used unmodified, as a separate library) |
| boto3 | Apache-2.0 |
| requests | Apache-2.0 |
| numpy | BSD-3-Clause |
| yt-dlp | Unlicense (public domain) |
| matplotlib | Matplotlib License (PSF-based, BSD-style) |
| imageio-ffmpeg | BSD-2-Clause (downloads a separate FFmpeg binary: GPL/LGPL, run as a separate program) |
| librosa | ISC |
| pillow | MIT-CMU (HPND) |
| scipy, numba, soundfile, scikit-learn (via librosa) | BSD-3-Clause / BSD |

### npm packages (`package.json`; `npm ci`)

Direct dependencies:

| Package | Licence | Package | Licence |
|---|---|---|---|
| next | MIT | react, react-dom | MIT |
| next-auth (Auth.js) | ISC | @prisma/client, prisma | Apache-2.0 |
| @aws-sdk/client-s3, @aws-sdk/s3-request-presigner | Apache-2.0 | bcryptjs | BSD-3-Clause |
| radix-ui | MIT | lucide-react | ISC |
| class-variance-authority | Apache-2.0 | clsx, tailwind-merge, tw-animate-css | MIT |
| fast-json-patch | MIT | nanoid | MIT |
| server-only | MIT | sonner | MIT |
| zod | MIT | zustand | MIT |
| qrcode (phone link QR) | MIT | @types/qrcode | MIT |
| tailwindcss, @tailwindcss/postcss | MIT | typescript | Apache-2.0 |
| eslint, eslint-config-next, @eslint/eslintrc | MIT | tsx | MIT |
| @types/* | MIT | | |

Transitive dependencies (587 packages in `package-lock.json`) are MIT, ISC, Apache-2.0, BSD, 0BSD, CC0, CC-BY-4.0,
BlueOak-1.0.0 or Python-2.0, apart from these:

| Package | Licence | Notes |
|---|---|---|
| `@img/sharp-libvips-*`, `@img/sharp-win32-*` (Next.js image optimisation, optional) | LGPL-3.0-or-later (libvips) + Apache-2.0 | prebuilt shared library, dynamically loaded and unmodified |
| `lightningcss` + platform binaries (Tailwind build) | MPL-2.0 | build tool, unmodified |
| `axe-core` (eslint-plugin-jsx-a11y, dev only) | MPL-2.0 | lint only, unmodified |

To regenerate the full list: `npx license-checker --summary` (or read `license` fields in `package-lock.json`).

## 3. External programs (not bundled)

| Program | Licence | Used for |
|---|---|---|
| [FFmpeg](https://ffmpeg.org) (gyan.dev "full" build, installed with winget) | GPL-3.0 (that build includes GPL parts: x264, vid.stab, libvmaf, etc.) | All decoding, filtering and encoding, run as a separate process |
| Node.js | MIT | Web app, agent runner |
| Python | PSF License | Worker, tools |
| PostgreSQL | PostgreSQL License (BSD-style) | Database |
| Git | GPL-2.0 | Fetching video-use |
| [Claude Code](https://claude.com/claude-code) (Anthropic) | Proprietary, Anthropic's commercial terms | Headless `claude -p` jobs on the user's own Claude subscription |
| Docker Desktop (optional) | Docker subscription terms | Optional local Postgres via `docker compose` |

ReelSmith calls these as separate executables and doesn't link them. Each user installs them under their own licences.

## 4. Not used: OpenMontage (AGPL-3.0)

[OpenMontage](https://github.com/calesthio/OpenMontage) was cloned outside this repository (never inside it, and
`OpenMontage/` is gitignored) and was read for a feature comparison only. **No OpenMontage code is in ReelSmith.** On
2026-10-09, every file to be committed (186 files, 11,069 non-trivial lines) was compared line by line with all 1,798
OpenMontage source files. 122 lines matched, all boilerplate such as `from __future__ import annotations`, argparse setup
and React imports, and the longest run of consecutive matching lines was 3: shadcn's standard `cn()` helper, which
both projects take from shadcn/ui (MIT). No file has a GPL or AGPL header.
