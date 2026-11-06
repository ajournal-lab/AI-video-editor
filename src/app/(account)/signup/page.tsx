import { Suspense } from "react";
import { AuthForm } from "@/components/site/AuthForm";

export const metadata = { title: "Create account · AJOURNALLAB Studio" };

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Create your account</h1>
      <p className="mb-6 text-sm text-muted-foreground">Free, no watermark, no limits. Bring your voice.</p>
      <Suspense>
        <AuthForm mode="signup" />
      </Suspense>
    </>
  );
}
