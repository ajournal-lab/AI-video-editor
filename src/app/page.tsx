import Link from "next/link";
import { ArrowRight, Captions, Download, Mic, Scissors, SlidersHorizontal, Sparkles, Wand2, Layers, History, Music } from "lucide-react";
import { auth } from "@/auth";
import { Logo } from "@/components/site/Logo";
import { Button } from "@/components/ui/button";

const STEPS = [
  { icon: Mic, title: "Record", body: "Upload a voiceover or record it right in the browser. Your voice sets the pace." },
  { icon: Wand2, title: "Auto-edit", body: "Whisper transcribes every word with timings, then scenes are split and matched to your own clips and photos." },
  { icon: SlidersHorizontal, title: "Fine-tune", body: "A real multi-track timeline: trim, split, transitions, text, captions, music ducking — or just tell the AI what to change." },
  { icon: Download, title: "Download", body: "Render a captioned MP4 in 720p or 1080p that matches the preview. Re-render as often as you like." },
];

const FEATURES = [
  { icon: Captions, title: "Word-by-word captions", body: "Four styles, editable per word, and they stay synced after every trim." },
  { icon: Scissors, title: "One-click silence trim", body: "Cut every pause over 0.7s from the whole video; visuals and captions follow." },
  { icon: Sparkles, title: "AI edit commands", body: "“Make scene 3 moodier.” See the proposed change as a diff, then apply or reject. Always undoable." },
  { icon: Layers, title: "Multi-track editor", body: "Video, voice, music, text and caption tracks with snapping, zoom and keyboard shortcuts." },
  { icon: Music, title: "Music that ducks", body: "Background music dips under your voice automatically, plus volume keyframes." },
  { icon: History, title: "Versions & history", body: "Unlimited undo, autosave, named snapshots, and every render tied to its exact version." },
];

const FAQ = [
  { q: "Do I need editing skills?", a: "No. You get a finished first cut automatically. The editor is there when you want control, and the AI command box handles most tweaks in plain English." },
  { q: "Can I use my own footage?", a: "Yes — it's built for it. Upload videos and photos to your library; descriptive file names decide which scene each one matches." },
  { q: "Are there watermarks or limits?", a: "No watermark, no usage caps, unlimited edits and re-renders." },
  { q: "Will the export look like the preview?", a: "Yes. The preview and the renderer read the same timeline JSON with the same fonts, color math, transitions and caption layout." },
  { q: "What languages work?", a: "Transcription auto-detects the language (Whisper), so captions work for most major languages." },
  { q: "Who owns the videos?", a: "You do. Everything runs on your own machine with your own media." },
];

export default async function Landing() {
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);
  const cta = signedIn ? { href: "/dashboard", label: "Open your projects" } : { href: "/signup", label: "Make a video — free" };

  return (
    <div className="overflow-x-hidden">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-background/70 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-2 text-sm sm:gap-4">
            <a href="#how" className="hidden text-muted-foreground hover:text-foreground sm:block">
              How it works
            </a>
            <a href="#faq" className="hidden text-muted-foreground hover:text-foreground sm:block">
              FAQ
            </a>
            {signedIn ? (
              <Button asChild size="sm" variant="secondary">
                <Link href="/dashboard">Dashboard</Link>
              </Button>
            ) : (
              <>
                <Link href="/login" className="px-2 text-muted-foreground hover:text-foreground">
                  Sign in
                </Link>
                <Button asChild size="sm">
                  <Link href="/signup">Start free</Link>
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <section className="bg-grid relative">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-gradient-to-b from-violet-600/15 via-pink-500/5 to-transparent" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.15fr_1fr]">
          <div className="text-center lg:text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-400" /> Voice-first AI video editor
            </span>
            <h1 className="mt-6 text-4xl leading-[1.05] font-extrabold tracking-tight sm:text-6xl">
              Talk. Get a <span className="text-gradient">ready-to-post video</span>. Then make it yours.
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground lg:mx-0">
              Record your voiceover and AJOURNALLAB Studio cuts a first edit with matching visuals and word-by-word captions — then hands you a real timeline editor with unlimited edits.
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <Button asChild size="lg" className="brand-gradient px-6 text-white">
                <Link href={cta.href}>
                  {cta.label} <ArrowRight />
                </Link>
              </Button>
              <span className="text-sm text-muted-foreground">No watermark · no caps</span>
            </div>
          </div>
          <div className="relative mx-auto w-full max-w-[300px]">
            <div className="absolute -inset-8 rounded-[3rem] bg-gradient-to-tr from-violet-600/30 to-pink-500/20 blur-3xl" />
            <div className="relative overflow-hidden rounded-[2rem] border border-white/15 bg-black p-2 shadow-2xl">
              <video
                src="/sample/sample-output.mp4"
                poster="/sample/sample-poster.jpg"
                autoPlay
                muted
                loop
                playsInline
                className="aspect-[9/16] w-full rounded-[1.5rem] bg-zinc-900 object-cover"
              />
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">Sample output: a 48-second voiceover, auto-edited.</p>
          </div>
        </div>
      </section>

      <section id="how" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 className="text-center text-3xl font-bold tracking-tight">How it works</h2>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <div key={s.title} className="rounded-2xl border bg-card/60 p-6">
              <div className="flex items-center gap-3">
                <span className="brand-gradient flex size-9 items-center justify-center rounded-xl text-white">
                  <s.icon className="size-4" />
                </span>
                <span className="text-xs text-muted-foreground">Step {i + 1}</span>
              </div>
              <h3 className="mt-4 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y bg-card/30">
        <div className="mx-auto grid max-w-6xl gap-x-8 gap-y-10 px-4 py-20 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title}>
              <f.icon className="size-5 text-violet-400" />
              <h3 className="mt-3 font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <h2 className="text-center text-3xl font-bold tracking-tight">FAQ</h2>
        <div className="mt-10 divide-y rounded-2xl border">
          {FAQ.map((f) => (
            <details key={f.q} className="group p-5 open:bg-card/40">
              <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
                {f.q}
                <span className="text-muted-foreground transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-sm text-muted-foreground">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="px-4 pb-24 sm:px-6">
        <div className="mx-auto max-w-4xl rounded-3xl border bg-gradient-to-br from-violet-600/20 via-card to-pink-500/10 p-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight">Your voice is the script.</h2>
          <p className="mt-3 text-muted-foreground">Record once, edit forever. Start with our sample project if you don&apos;t have a recording handy.</p>
          <Button asChild size="lg" className="mt-8">
            <Link href={cta.href}>
              {cta.label} <ArrowRight />
            </Link>
          </Button>
        </div>
      </section>

      <footer className="border-t py-8 text-center text-xs text-muted-foreground">© {new Date().getFullYear()} AJOURNALLAB</footer>
    </div>
  );
}
