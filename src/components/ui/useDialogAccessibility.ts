import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface UseDialogAccessibilityOptions {
  isOpen: boolean;
  onClose: () => void;
  canClose?: boolean;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

export function useDialogAccessibility({
  isOpen,
  onClose,
  canClose = true,
  fallbackFocusRef,
}: UseDialogAccessibilityOptions) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);

  onCloseRef.current = onClose;
  canCloseRef.current = canClose;

  const rememberTrigger = useCallback((element?: HTMLElement | null) => {
    const activeElement = element ?? document.activeElement;
    previousFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!previousFocusRef.current) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }

    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const getFocusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element.tabIndex >= 0
        && element.getAttribute('aria-hidden') !== 'true'
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden');

    const initialFocus = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus], [autofocus]')
      ?? getFocusableElements()[0]
      ?? dialog;
    initialFocus.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (canCloseRef.current) onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        event.stopPropagation();
        dialog.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      const focusIsOutside = !(activeElement instanceof Node) || !dialog.contains(activeElement);

      if (event.shiftKey && (activeElement === first || activeElement === dialog || focusIsOutside)) {
        event.preventDefault();
        event.stopPropagation();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || focusIsOutside)) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previousFocus?.isConnected && !previousFocus.matches(':disabled')) {
        previousFocus.focus();
      } else if (fallbackFocusRef?.current?.isConnected) {
        fallbackFocusRef.current.focus();
      }
    };
  }, [isOpen, fallbackFocusRef]);

  return { dialogRef, rememberTrigger };
}
