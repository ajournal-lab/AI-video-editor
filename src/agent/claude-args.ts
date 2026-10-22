// Command line + system prompt for one headless claude run.
import { checklistPath, fwd, gotchasPath, studioDir, styleDir } from "./config";
import { checklistForPrompt, readGotchasFile } from "./rulesfile";

/** Permission rule path for Write/Edit: "//c/Users/..." (POSIX form of an absolute Windows path). */
function rulePath(p: string) {
  const f = fwd(p);
  const m = /^([A-Za-z]):\/(.*)$/.exec(f);
  return m ? `//${m[1].toLowerCase()}/${m[2]}` : f.startsWith("/") ? `/${f}` : f;
}

/**
 * Explicit allowlist (no blanket bypass). Anything else is denied without a prompt
 * (--permission-mode dontAsk). Bash is limited to the media tools, and python only
 * runs scripts from the skill/tool folders or the project's own edit/scripts/.
 */
export function allowedTools(projectDir: string): string[] {
  const proj = fwd(projectDir);
  const studio = fwd(studioDir());
  return [
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    `Write(${rulePath(projectDir)}/**)`,
    `Edit(${rulePath(projectDir)}/**)`,
    "Bash(ffmpeg *)",
    "Bash(ffprobe *)",
    `Bash(python ${studio}/tools/*)`,
    `Bash(python ${studio}/.claude/skills/*)`,
    `Bash(python ${proj}/edit/scripts/*)`,
    "Bash(python -m pip install *)",
    "Bash(pip install *)",
    "Bash(python -m yt_dlp *)",
    "Bash(yt-dlp *)",
    "Bash(gdown *)",
    `Bash(mkdir -p ${proj}/*)`,
  ];
}

export function systemPrompt(opts: { projectDir: string; outputFile?: string | null; extraDirs: string[]; jobId?: string }) {
  const proj = fwd(opts.projectDir);
  const studio = fwd(studioDir());
  const gotchas = readGotchasFile() || "(gotchas.md not found)";
  const gotchaFile = `${proj}/jobs/${opts.jobId ?? "job"}.gotchas.json`;
  return `# ReelSmith headless run
You are running headlessly inside ReelSmith, a local reel editor, through \`claude -p\`. Nobody can answer questions
or approve anything during this run: never ask. Make sensible choices, note assumptions in the output file, and finish.

## Paths
- Project folder (the only place you may write): ${proj}
  raw/ = imported media (never modify or move), edit/ = working files (video-use layout), render/ = outputs.
- Workspace with the skills: ${studio}  (video-use helpers: ${studio}/.claude/skills/video-use/helpers/,
  edit-reel scripts: ${studio}/.claude/skills/edit-reel/scripts/, local tools: ${studio}/tools/)
- Also readable: ${opts.extraDirs.map(fwd).join(", ") || "(none)"}; style reference reels: ${fwd(styleDir())}
${opts.outputFile ? `\n## Output\nWrite your result to exactly ${proj}/${opts.outputFile} as valid JSON matching the requested shape.\nReelSmith reads only that file, never this chat, so put everything that matters in it.\n` : ""}
## Tool rules (anything else is denied automatically)
- Bash may only run: ffmpeg, ffprobe, \`python <script>\` for scripts under ${studio}/tools/, ${studio}/.claude/skills/ or
  ${proj}/edit/scripts/, pip install, python -m yt_dlp / yt-dlp, gdown, and \`mkdir -p ${proj}/...\`.
- Always use absolute paths with forward slashes (C:/... not C:\\...). One command per Bash call: no cd, no &&, no env-var prefixes
  (PYTHONIOENCODING=utf-8 is already set). Quote paths that contain spaces.
- To run your own Python, Write it to ${proj}/edit/scripts/<name>.py and run it with python. \`python -c\` is denied.
- List and read files with Glob, Grep and Read (not ls/cat).
- No paid APIs or API keys. Transcription is local: python ${studio}/tools/transcribe_local.py <video> --edit-dir ${proj}/edit
  (never video-use's transcribe.py / transcribe_batch.py, which call ElevenLabs).
- Your Claude subscription has usage limits: look at contact sheets / sampled frames, not every frame.

## Before every edit: the taste checklist and the gotchas (both below, re-read on every turn)
- ${fwd(checklistPath())}: every active rule an edit is held to, with the user's own words. Apply each rule's intent even when
  its wording is loose. Never edit or delete a rule yourself: ReelSmith files new rules from the user's notes.
- ${fwd(gotchasPath())}: every technical problem already hit and how it was fixed. Check it before you debug anything.
- Fix the cause, not just the moment the user named: then check the whole video for the same problem and fix it too (R4).
- When something breaks during this run and you fix it (a command fails, a tool errors, a file is invalid, a workaround was
  needed), write it down BEFORE moving on: append to ${gotchaFile} a JSON array of
  {"title": "short problem", "problem": "what failed (the error)", "why": "the cause", "fix": "what fixed it", "area": "render|import|agent|setup|editor|audio|quality|other"}.
  ReelSmith adds them to gotchas.md. A problem already in gotchas.md: use its fix; file it again only if the fix changed.

# taste-checklist.md
${checklistForPrompt()}

# gotchas.md
${gotchas}`;
}

export function claudeArgs(opts: {
  sessionId: string;
  resume: boolean;
  projectDir: string;
  extraDirs: string[];
  systemPromptFile: string;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    opts.resume ? "--resume" : "--session-id",
    opts.sessionId,
    "--permission-mode",
    "dontAsk",
    // only the workspace's project settings: the user's global settings can't widen the allowlist
    "--setting-sources",
    "project",
    // no claude.ai connectors / MCP servers in headless runs
    "--strict-mcp-config",
    "--system-prompt-snapshot",
    "off", // re-read the checklist and gotchas on every resumed turn
    "--append-system-prompt-file",
    opts.systemPromptFile,
    "--add-dir",
    opts.projectDir,
    ...opts.extraDirs.flatMap((d) => ["--add-dir", d]),
    "--allowedTools",
    ...allowedTools(opts.projectDir),
  ];
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
  return args;
}
