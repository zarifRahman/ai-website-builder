"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { BuilderShell } from "@/components/builder/BuilderShell";
import { ErrorState } from "@/components/states/ErrorState";
import { Loading } from "@/components/states/Loading";

export default function ProjectPage() {
  // useParams only resolves at runtime — it must sit behind a Suspense
  // boundary or static prerendering is blocked (Next 16 cacheComponents).
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-5xl p-6">
          <Loading label="Loading project…" />
        </div>
      }
    >
      <ProjectPageInner />
    </Suspense>
  );
}

function ProjectPageInner() {
  const params = useParams();
  const raw = params.id;
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (!id) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <Loading label="Loading project…" />
      </div>
    );
  }

  if (id === "") {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <ErrorState message="Missing project id in the URL." />
      </div>
    );
  }

  return <BuilderShell projectId={id} />;
}
