// src/components/ui/address-autocomplete.tsx
import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

export type AddressParts = {
  street: string;
  city: string;
  state: string;
  zip: string;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSelect: (parts: AddressParts) => void;
  placeholder?: string;
  className?: string;
};

type GACComponent = { types: string[]; long_name: string; short_name: string };

declare global {
  interface Window {
    __googlePlacesReady?: boolean;
    __googlePlacesCallbacks?: (() => void)[];
    initGooglePlacesCallback?: () => void;
  }
}

function ensureScript(apiKey: string, onReady: () => void) {
  if (window.__googlePlacesReady) { onReady(); return; }
  if (!window.__googlePlacesCallbacks) window.__googlePlacesCallbacks = [];
  window.__googlePlacesCallbacks.push(onReady);
  if (document.querySelector('script[data-google-places]')) return;

  window.initGooglePlacesCallback = () => {
    window.__googlePlacesReady = true;
    window.__googlePlacesCallbacks?.forEach(cb => cb());
    window.__googlePlacesCallbacks = [];
  };

  const script = document.createElement("script");
  script.setAttribute("data-google-places", "true");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=initGooglePlacesCallback&loading=async`;
  script.async = true;
  document.head.appendChild(script);
}

function applyPacFix(pac: HTMLElement) {
  if (pac.dataset.pacFixed) return;
  pac.dataset.pacFixed = "1";
  pac.style.zIndex = "99999";
  pac.style.pointerEvents = "auto";
  // Stop pointerdown from bubbling to Radix's document-level dismiss listener.
  // Do NOT preventDefault — that would cancel the click event and break Google's selection.
  pac.addEventListener("pointerdown", e => e.stopPropagation());
}

function fixPacContainer() {
  // Fix all existing unfixed pac-containers immediately.
  // Google creates a NEW pac-container for each Autocomplete instance, so
  // querySelector(".pac-container") would find the OLD (already-fixed) one
  // and skip the new one — :not([data-pac-fixed]) ensures we target only new ones.
  document.querySelectorAll<HTMLElement>(".pac-container:not([data-pac-fixed])").forEach(applyPacFix);

  // Watch continuously for new pac-containers created by subsequent Autocomplete instances.
  const observer = new MutationObserver(() => {
    document.querySelectorAll<HTMLElement>(".pac-container:not([data-pac-fixed])").forEach(applyPacFix);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}

export function AddressAutocomplete({
  value, onChange, onSelect,
  placeholder = "123 Main St", className,
}: Props) {
  const inputRef    = useRef<HTMLInputElement>(null);
  const acRef       = useRef<unknown>(null);
  const onSelectRef = useRef(onSelect);
  const onChangeRef = useRef(onChange);

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_PLACES_API_KEY as string | undefined;
    if (!apiKey) {
      console.warn("[AddressAutocomplete] VITE_GOOGLE_PLACES_API_KEY not set");
      return;
    }

    const observer = fixPacContainer();

    ensureScript(apiKey, () => {
      if (!inputRef.current || acRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const google = (window as any).google;
      if (!google?.maps?.places) return;

      const ac = new google.maps.places.Autocomplete(inputRef.current, {
        types: ["address"],
        componentRestrictions: { country: "us" },
        fields: ["address_components", "formatted_address"],
      });
      acRef.current = ac;

      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        if (!place) return;

        const get      = (type: string) => (place.address_components as GACComponent[] | undefined)?.find(c => c.types.includes(type))?.long_name  ?? "";
        const getShort = (type: string) => (place.address_components as GACComponent[] | undefined)?.find(c => c.types.includes(type))?.short_name ?? "";

        const street = [get("street_number"), get("route")].filter(Boolean).join(" ");
        const city   = get("locality") || get("sublocality") || get("neighborhood");
        const state  = getShort("administrative_area_level_1");
        const zip    = get("postal_code");

        onSelectRef.current({ street, city, state, zip });
        onChangeRef.current(place.formatted_address || street || "");
      });
    });

    return () => {
      observer.disconnect();
      acRef.current = null;
    };
  }, []);

  return (
    <Input
      ref={inputRef}
      className={className}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="off"
    />
  );
}
