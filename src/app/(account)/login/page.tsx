import { Suspense } from "react";
import { AuthForm } from "@/components/site/AuthForm";

export const metadata = { title: "Sign in · AJOURNALLAB Studio" };

export default function LoginPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Welcome back</h1>
      <p className="mb-6 text-sm text-muted-foreground">Sign in to keep editing.</p>
      <Suspense>
        <AuthForm mode="login" />
      </Suspense>
    </>
  );
}
