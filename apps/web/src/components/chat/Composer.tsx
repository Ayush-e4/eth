"use client";

import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import { SendIcon } from "../icons";

/** The message box: Enter sends, Shift+Enter adds a line. */
export function Composer({
  onSend,
  disabled,
  placeholder = "Ask anything",
  toolbar,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  toolbar?: ReactNode;
}) {
  const [text, setText] = useState("");
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
  };
  return (
    <form
      onSubmit={send}
      aria-label="Message the concierge"
      className="flex flex-col gap-2.5 rounded-[20px] border border-line-2 bg-white p-3.5 shadow-[0_1px_2px_rgba(24,32,38,0.05),0_10px_30px_rgba(24,32,38,0.06)]"
    >
      <label htmlFor="msg" className="sr-only">
        Message
      </label>
      <textarea
        id="msg"
        rows={2}
        value={text}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        className="resize-none bg-transparent px-1.5 pt-1.5 text-base leading-normal outline-none placeholder:text-[#6B747C]"
      />
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <span className="flex-1" />
        <button
          type="submit"
          aria-label="Send"
          disabled={disabled || !text.trim()}
          className="flex size-10 items-center justify-center rounded-full bg-teal text-white hover:bg-teal-dark disabled:opacity-40"
        >
          <SendIcon />
        </button>
      </div>
    </form>
  );
}
