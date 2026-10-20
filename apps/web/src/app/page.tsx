import { APP } from "@eth/shared";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">{APP.name}</h1>
      <p className="text-neutral-600 dark:text-neutral-400">{APP.tagline}</p>
    </main>
  );
}
