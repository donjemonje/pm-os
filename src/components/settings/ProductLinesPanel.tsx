"use client";

import { useState } from "react";
import { Check, GripVertical, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { UmMarkdown } from "@/components/documents/UmMarkdown";
import { cn } from "@/lib/utils";
import type { SettingsListItem } from "./SettingsListPanel";
import { UsageCounts } from "./UsageCounts";
import { PRODUCT_CHIP_DEFAULT } from "@/lib/ideas/colors";
import { ColorSwatch } from "./ColorSwatch";
import { useConfirm } from "@/components/ui/ConfirmDialog";

const ENDPOINT = "/api/ideas/lists/product-lines";
const MAX_DESCRIPTION = 2000;

const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]";

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
  /** Row being dragged (drag & drop reorder). */
  const [dragId, setDragId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAliases, setEditAliases] = useState("");
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
    if (await call("POST", { name, description, aliases })) {
      setName("");
      setDescription("");
      setAliases("");
      setAdding(false);
    }
  }

  function startEdit(item: SettingsListItem) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditDescription(item.description);
    setEditAliases((item.aliases ?? []).join(", "));
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
  }

  async function onSaveEdit(id: string) {
    if (
      await call("PATCH", { id, name: editName, description: editDescription, aliases: editAliases })
    ) {
      setEditingId(null);
    }
  }

  /** Drag & drop: drop the dragged row where the pointer is, persist the full order. */
  async function dropOn(targetId: string) {
    const from = items.findIndex((i) => i.id === dragId);
    const to = items.findIndex((i) => i.id === targetId);
    setDragId(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next);
    await call("PUT", { order: next.map((i) => i.id) });
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

  /** Other spellings of the same product line: the customer's Jira option name, reporters' variants. */
  const aliasesEditor = (value: string, onChange: (v: string) => void) => (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Aliases, comma-separated (optional)"
      title="Other names that mean this product line. Imports map any of them here; the sync to Jira writes whichever one is a Jira option."
      className={`${INPUT_CLASS} text-[13px]`}
    />
  );

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
    <section>
      <div className="mb-1 flex items-end justify-between gap-4">
        <h2 className="font-title m-0 text-[15px] font-semibold">Product Lines</h2>
        <div className="flex items-center gap-1.5">
          {canEdit && !adding && (
            <button
              onClick={() => setAdding(true)}
              className="mr-2 inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-white px-3 text-[12px] font-medium hover:border-primary"
            >
              <Plus size={13} /> Add product line
            </button>
          )}
        </div>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        The products ideas can belong to — this text is the ground truth PMOS AI uses to classify
        tickets. The order here is the order filters list them in.{" "}
        {canEdit
          ? "Markdown is supported; drag a row by its handle to reorder."
          : "Managed by your organization's admin; read-only for members."}
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-[#f3c9d5] bg-[#fdeef2] px-3 py-2 text-[13px] text-[#c94266]">
          {error}
        </div>
      )}

      {canEdit && adding && (
      <div
        className="mb-3 flex flex-col gap-2 rounded-xl border border-border bg-white px-5 py-4"
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
        {aliasesEditor(aliases, setAliases)}
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
      )}

      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <div
            key={item.id}
            onDragOver={(e) => {
              if (dragId && dragId !== item.id) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              void dropOn(item.id);
            }}
            className={cn(
              "rounded-xl border border-border bg-white px-5 py-4 transition-shadow",
              dragId === item.id && "opacity-50",
              dragId && dragId !== item.id && "hover:shadow-[0_-2px_0_0_var(--app-accent)]",
            )}
          >
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
                {aliasesEditor(editAliases, setEditAliases)}
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
                    {item.usage && <UsageCounts {...item.usage} />}
                  </span>
                  {canEdit && (
                    <span className="flex shrink-0 items-center gap-1">
                      <span
                        draggable={!busy}
                        onDragStart={(e) => {
                          setDragId(item.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => setDragId(null)}
                        title="Drag to reorder"
                        className="flex h-7 w-7 cursor-grab items-center justify-center rounded-lg text-[#7a8aa3] hover:bg-background hover:text-foreground active:cursor-grabbing"
                      >
                        <GripVertical size={14} />
                      </span>
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
                {(item.aliases ?? []).length > 0 && (
                  <p className="-mt-1 mb-2 text-[12px] text-muted">
                    Also called: {(item.aliases ?? []).join(", ")}
                  </p>
                )}
                {item.description ? (
                  <UmMarkdown content={item.description} className="text-[13px]" />
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
            {canEdit ? " Add the first one with the button above." : ""}
          </div>
        )}
      </div>

    </section>
  );
}
