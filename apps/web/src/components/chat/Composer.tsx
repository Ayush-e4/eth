"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SendIcon } from "../icons";

const MAX_HEIGHT = 200; // about 8 lines, then it scrolls

/**
 * The message box. It grows with what you type. On a keyboard, Enter sends and Shift+Enter adds
 * a line; on a phone, Enter adds a line and the button sends (as in messaging apps).
 */
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
  const area = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) send(e);
  };
  return (
    <form
      onSubmit={send}
      aria-label="Message the concierge"
      className="flex flex-col rounded-[22px] border border-line-2 bg-white shadow-[0_1px_2px_rgba(24,32,38,0.05),0_10px_30px_rgba(24,32,38,0.06)] transition-[border-color,box-shadow] focus-within:border-teal/50 focus-within:shadow-[0_0_0_3px_rgba(14,90,100,0.12),0_10px_30px_rgba(24,32,38,0.06)]"
    >
      <label htmlFor="msg" className="sr-only">
        Message
      </label>
      <textarea
        id="msg"
        ref={area}
        rows={1}
        value={text}
        maxLength={4000}
        enterKeyHint="send"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        className="block max-h-[200px] min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base leading-6 outline-none placeholder:text-[#6B747C] focus-visible:outline-none"
      />
      <div className="flex items-center gap-2 px-2.5 pt-1 pb-2.5">
        {toolbar}
        <span className="flex-1" />
        <button
          type="submit"
          aria-label="Send"
          disabled={disabled || !text.trim()}
          className="flex size-10 flex-none items-center justify-center rounded-full bg-teal text-white transition-opacity hover:bg-teal-dark disabled:opacity-35"
        >
          <SendIcon />
        </button>
      </div>
    </form>
  );
}
