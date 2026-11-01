"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { cancelled, thisDevice, withFaceId } from "@/lib/passkey";

interface Device {
  id: string;
  label: string | null;
  addedAt: string;
  onWallet: boolean;
}
type List = { devices: Device[]; wallet: { status: string; multiDevice: boolean } | null };

const small = "h-9 rounded-[10px] border px-3 text-[13px] font-semibold disabled:opacity-60";
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/**
 * Your devices: each has its own passkey. A new one joins with a code from here (it can then
 * sign in), and Face ID on a device the wallet trusts lets it pay too. A lost one is shut out.
 */
export function Devices() {
  const [list, setList] = useState<List | null>(null);
  const [link, setLink] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const known = useRef<number | null>(null);
  const me = useRef<string | null>(null);

  const load = useCallback(async () => {
    const l = await api<List>("/account/devices").catch(() => null);
    if (!l) return;
    // A new device joined with the code on screen: put the code away, ask to approve it.
    if (known.current !== null && l.devices.length > known.current) {
      setLink(null);
      setNote(
        "Your new device is signed in. Let it pay from your wallet below, with Face ID here.",
      );
    }
    known.current = l.devices.length;
    setList(l);
  }, []);
  useEffect(() => {
    me.current = thisDevice();
    if (new URLSearchParams(window.location.search).get("device") === "added")
      setNote(
        "This device is signed in. To pay from it, approve it on your other device: Wallet → Your devices.",
      );
    void load();
  }, [load]);
  useEffect(() => {
    if (!link) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [link, load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      if (!cancelled(err))
        setNote(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
      void load();
    }
  };
  const faceId = (d: Device, action: "add" | "remove") =>
    act(d.id, () =>
      withFaceId(
        `/account/devices/${d.id}/wallet/face-id`,
        { action },
        `/account/devices/${d.id}/wallet`,
      ),
    );
  const forget = (d: Device) =>
    act(d.id, () => api(`/account/devices/${d.id}`, { method: "DELETE" }));
  const addDevice = () =>
    act("link", async () => setLink(await api("/account/devices/link", { method: "POST" })));

  if (!list) return null;
  const multi = list.wallet?.multiDevice ?? false;
  const payers = list.devices.filter((d) => d.onWallet).length;
  const url = link && `${window.location.origin}/link#${link.code}`;
  return (
    <section id="devices" aria-labelledby="devices-h" className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="devices-h" className="text-lg font-bold">
          Your devices
        </h2>
        {!link && (
          <button
            type="button"
            onClick={addDevice}
            disabled={busy !== null}
            className={`${small} border-line-2 bg-white`}
          >
            Add another device
          </button>
        )}
      </div>
      <p className="text-sm text-ink-3">
        {multi
          ? "Each device has its own passkey. Devices marked “can pay” approve limits with their Face ID or fingerprint; we can't add one without yours."
          : "Devices you add can sign in and chat. Payments are approved on the device that made this account: its wallet was made before an account could have several."}
      </p>
      {link && url && (
        <div className="flex flex-wrap items-center gap-5 rounded-2xl border border-line bg-white p-4">
          <QRCodeSVG value={url} size={148} marginSize={1} aria-label="QR code to add a device" />
          <div className="flex min-w-[220px] flex-1 flex-col gap-2 text-sm">
            <span className="text-ink-3">On the new device, scan this, or open</span>
            <span className="font-semibold break-all">{window.location.host}/link</span>
            <span className="text-ink-3">and type</span>
            <span className="font-mono text-2xl font-bold tracking-widest">{link.code}</span>
            <span className="text-xs text-muted">
              Works once, until{" "}
              {new Date(link.expiresAt).toLocaleTimeString("en-IN", { timeStyle: "short" })}.
              Waiting for it…
            </span>
          </div>
          <button
            type="button"
            onClick={() => setLink(null)}
            className={`${small} border-line-2 bg-white`}
          >
            Done
          </button>
        </div>
      )}
      {note && <p className="rounded-xl bg-side px-4 py-3 text-sm text-ink-3">{note}</p>}
      <ul className="overflow-hidden rounded-2xl border border-line">
        {list.devices.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#F1EEE8] px-4 py-3 text-sm first:border-t-0"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">
                {d.label ?? "Passkey"}
                {d.id === me.current && (
                  <span className="ml-2 text-xs font-normal text-muted">this device</span>
                )}
              </span>
              <span className="text-xs text-muted">
                added {day(d.addedAt)} · {d.onWallet ? "can pay" : "signs in only"}
              </span>
            </span>
            {multi && !d.onWallet && (
              <button
                type="button"
                onClick={() => faceId(d, "add")}
                disabled={busy !== null}
                className={`${small} border-teal bg-teal text-white`}
              >
                Let it pay (Face ID)
              </button>
            )}
            {(d.onWallet ? multi && payers > 1 : list.devices.length > 1) && (
              <button
                type="button"
                onClick={() => (d.onWallet ? faceId(d, "remove") : forget(d))}
                disabled={busy !== null}
                className={`${small} border-[#E8B4AE] bg-white text-bad`}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
