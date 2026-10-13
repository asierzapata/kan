import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { authClient } from "../lib/auth";

export function SignIn() {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = creating
      ? await authClient.signUp.email({ email, password, name: name.trim() || email.split("@")[0] })
      : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error)
      setError(result.error.message || (creating ? "Could not create the account." : "Could not sign in."));
  }
  return (
    <form className="web-signin" onSubmit={submit}>
      {creating && (
        <Field>
          <FieldLabel htmlFor="signin-name">Name</FieldLabel>
          <Input
            id="signin-name"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="signin-email">Email</FieldLabel>
        <Input
          id="signin-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="signin-password">Password</FieldLabel>
        <Input
          id="signin-password"
          type="password"
          required
          minLength={8}
          autoComplete={creating ? "new-password" : "current-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      {error && (
        <p role="alert" className="web-signin-error">
          {error}
        </p>
      )}
      <div className="web-signin-actions">
        <Button type="submit" disabled={busy}>
          {creating ? "Create account" : "Sign in"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setCreating(!creating);
            setError("");
          }}
        >
          {creating ? "I have an account" : "Create account"}
        </Button>
      </div>
    </form>
  );
}
