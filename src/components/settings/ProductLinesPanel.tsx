"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { UmMarkdown } from "@/components/documents/UmMarkdown";
import { cn } from "@/lib/utils";
import type { SettingsListItem } from "./SettingsListPanel";
import { PRODUCT_CHIP_DEFAULT } from "@/lib/ideas/colors";
import { ColorSwatch } from "./ColorSwatch";
import { useConfirm } from "@/components/ui/ConfirmDialog";

const ENDPOINT = "/api/ideas/lists/product-lines";
const MAX_DESCRIPTION = 2000;

const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]";

type ViewMode = "formatted" | "markdown";

function viewChip(active: boolean): string {
  return cn(
    "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
    active
      ? "border-transparent bg-primary text-white"
      : "border-border bg-white text-[#3f506b] hover:border-primary/55"
  );
}

/**
 * Product Lines — the AI's ground truth for classifying ideas. Everyone can
 * read it; only a PM-OS admin can change it (the API enforces the same rule).
 * The toggle switches between human-friendly rendering and the raw markdown
 * exactly as the model receives it.
 */
export function ProductLinesPanel({
  initialItems,
  canEdit,
}: {
  initialItems: SettingsListItem[];
  canEdit: boolean;
}) {
  const { confirm } = useConfirm();
  const [items, setItems] = useState(initialItems);
  const [view, setView] = useState<ViewMode>("formatted");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(method: "POST" | "PATCH" | "PUT" | "DELETE", body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setItems(data.items);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onAdd() {
    if (!name.trim()) return;
    if (await call("POST", { name, description })) {
      setName("");
      setDescription("");
      setAdding(false);
    }
  }

  function startEdit(item: SettingsListItem) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditDescription(item.description);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
  }

  async function onSaveEdit(id: string) {
    if (await call("PATCH", { id, name: editName, description: editDescription })) {
      setEditingId(null);
    }
  }

  /** Swap with the neighbor and persist the full order (position = index). */
  async function move(id: string, dir: -1 | 1) {
    const idx = items.findIndex((i) => i.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= items.length) return;
    const order = items.map((i) => i.id);
    [order[idx], order[j]] = [order[j], order[idx]];
    await call("PUT", { order });
  }

  async function onDelete(id: string, itemName: string) {
    if (!(await confirm({ title: `Delete "${itemName}"?`, confirmLabel: "Delete", tone: "danger" })))
      return;
    await call("DELETE", { id });
  }

  /** Cmd+Enter submits, Esc cancels — the standing textarea rules. */
  function editorKeys(onSubmit: () => void, onCancel: () => void) {
    return (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
  }

  const descriptionEditor = (value: string, onChange: (v: string) => void) => (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={7}
        maxLength={MAX_DESCRIPTION}
        placeholder="What is this product line? Markdown is fine — this text is exactly what PMOS reads when classifying ideas."
        className={`${INPUT_CLASS} resize-y font-mono text-[12.5px] leading-relaxed`}
      />
      <div className="mt-1 text-right font-mono text-[10.5px] text-[#9aa8be]">
        {value.length}/{MAX_DESCRIPTION}
      </div>
    </div>
  );

  return (
    <section className="max-w-3xl">
      <div className="mb-1 flex items-end justify-between gap-4">
        <h2 className="font-title m-0 text-[15px] font-semibold">Product Lines</h2>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setView("formatted")} className={viewChip(view === "formatted")}>
            Formatted
          </button>
          <button
            onClick={() => setView("markdown")}
            title="The raw text exactly as PMOS receives it"
            className={viewChip(view === "markdown")}
          >
            Markdown
          </button>
        </div>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        The products ideas can belong to — this text is the ground truth PMOS AI uses to classify
        tickets. The order here is the order filters list them in.{" "}
        {canEdit
          ? "Markdown is supported."
          : "Managed by your PM-OS admin; read-only for members."}
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-[#f3c9d5] bg-[#fdeef2] px-3 py-2 text-[13px] text-[#c94266]">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {items.map((item, index) => (
          <div key={item.id} className="rounded-xl border border-border bg-white px-5 py-4">
            {editingId === item.id ? (
              <div
                className="flex flex-col gap-2"
                onKeyDown={editorKeys(() => void onSaveEdit(item.id), cancelEdit)}
              >
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className={INPUT_CLASS}
                  maxLength={80}
                />
                {descriptionEditor(editDescription, setEditDescription)}
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={cancelEdit}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-white px-3 text-[13px] font-medium hover:border-primary"
                  >
                    <X size={13} /> Cancel
                  </button>
                  <button
                    onClick={() => void onSaveEdit(item.id)}
                    disabled={busy || !editName.trim()}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ColorSwatch
                      color={item.color}
                      fallback={PRODUCT_CHIP_DEFAULT}
                      name={item.name}
                      canEdit={!busy}
                      onPick={(color) => call("PATCH", { id: item.id, color })}
                    />
                    <span className="font-title text-[14px] font-semibold">{item.name}</span>
                  </span>
                  {canEdit && (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => void move(item.id, -1)}
                        disabled={busy || index === 0}
                        title="Move up"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-[#7a8aa3] hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        onClick={() => void move(item.id, 1)}
                        disabled={busy || index === items.length - 1}
                        title="Move down"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-[#7a8aa3] hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                      >
                        <ChevronDown size={14} />
                      </button>
                      <span className="mx-0.5 h-4 w-px bg-border" />
                      <button
                        onClick={() => startEdit(item)}
                        title="Edit"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-[#7a8aa3] hover:bg-background hover:text-foreground"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => void onDelete(item.id, item.name)}
                        title="Delete"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-[#7a8aa3] hover:bg-[#fdeef2] hover:text-[#c94266]"
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  )}
                </div>
                {item.description ? (
                  view === "formatted" ? (
                    <UmMarkdown content={item.description} className="text-[13px]" />
                  ) : (
                    <pre className="m-0 whitespace-pre-wrap rounded-lg bg-background px-3.5 py-3 font-mono text-[12px] leading-relaxed text-[#33445e]">
                      {item.description}
                    </pre>
                  )
                ) : (
                  <p className="m-0 text-[13px] italic text-muted">No description yet.</p>
                )}
              </>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-white px-5 py-8 text-center text-sm text-muted">
            No product lines yet.
            {canEdit ? " Add the first one below." : ""}
          </div>
        )}
      </div>

      {canEdit &&
        (adding ? (
          <div
            className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-white px-5 py-4"
            onKeyDown={editorKeys(() => void onAdd(), () => setAdding(false))}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              autoFocus
              className={INPUT_CLASS}
              maxLength={80}
            />
            {descriptionEditor(description, setDescription)}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setAdding(false)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-white px-3 text-[13px] font-medium hover:border-primary"
              >
                <X size={13} /> Cancel
              </button>
              <button
                onClick={() => void onAdd()}
                disabled={busy || !name.trim()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                Add product line
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-white px-3 text-[13px] font-medium hover:border-primary"
          >
            <Plus size={13} /> Add product line
          </button>
        ))}
    </section>
  );
}
