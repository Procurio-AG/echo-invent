"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

type Props = {
  /** When true, do not auto-refocus on blur. Used while a product form owns the focus. */
  released: boolean;
  onScan: (ean: string) => void;
  /** Fired when the input loses focus while not released. Caller may toast or show a re-arm UI. */
  onFocusLost?: () => void;
};

export type HiddenScanInputHandle = {
  focus: () => void;
};

export const HiddenScanInput = forwardRef<HiddenScanInputHandle, Props>(
  function HiddenScanInput({ released, onScan, onFocusLost }, ref) {
    const inputRef = useRef<HTMLInputElement>(null);
    const bufferRef = useRef("");
    const [armed, setArmed] = useState(false);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));

    const refocus = useCallback(() => {
      inputRef.current?.focus();
    }, []);

    useEffect(() => {
      if (released) return;
      refocus();
    }, [released, refocus]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const value = bufferRef.current.trim();
        bufferRef.current = "";
        if (inputRef.current) inputRef.current.value = "";
        if (value) onScan(value);
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      bufferRef.current = e.target.value;
    };

    const handleFocus = () => setArmed(true);
    const handleBlur = () => {
      setArmed(false);
      if (!released) onFocusLost?.();
    };

    return (
      <div
        onClick={refocus}
        className="cursor-text rounded-lg border border-border bg-surface p-5"
        aria-label="Scanner ready"
      >
        <div className="flex items-center gap-3">
          <span
            className={
              "inline-block h-2.5 w-2.5 rounded-full " +
              (armed ? "animate-pulse bg-emerald-400" : "bg-muted/40")
            }
            aria-hidden
          />
          <p className="text-sm">
            {armed ? (
              <>
                <span className="font-medium text-text">Listening</span>
                <span className="ml-2 text-xs text-muted">
                  scan a barcode or type and press Enter
                </span>
              </>
            ) : (
              <>
                <span className="font-medium text-yellow-300">Click here to re-arm scanner</span>
                <span className="ml-2 text-xs text-muted">focus was lost</span>
              </>
            )}
          </p>
        </div>
        <input
          ref={inputRef}
          type="text"
          autoFocus
          aria-hidden
          onKeyDown={handleKeyDown}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="sr-only"
        />
      </div>
    );
  }
);
