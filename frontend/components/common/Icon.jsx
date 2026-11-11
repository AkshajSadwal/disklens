export default function Icon({ name, size = 18, strokeWidth = 1.8 }) {
  const paths = {
    home: <><path d="M3 9.8 10 4l7 5.8"/><path d="M5.5 9v6.5h9V9"/><path d="M8.5 15.5v-3h3v3"/></>,
    storage: <><rect x="3" y="4" width="14" height="11" rx="2"/><path d="M6 8h8M6 11h5"/><circle cx="14" cy="12" r=".8" fill="currentColor" stroke="none"/></>,
    programs: <><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/></>,
    ai: <><path d="M6.5 3.5 8 6l2.5 1.5L8 9 6.5 11.5 5 9 2.5 7.5 5 6z"/><path d="M14 9.5 15 11l1.5 1-1.5 1-1 1.5-1-1.5-1.5-1 1.5-1z"/><path d="M12 3v2M11 4h2"/></>,
    shield: <><path d="M10 2.8 16 5v4.2c0 3.8-2.4 6-6 7.8-3.6-1.8-6-4-6-7.8V5z"/><path d="m7.2 9.8 1.8 1.8 3.8-4"/></>,
    settings: <><circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v2M10 15.2v2M17.2 10h-2M4.8 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3 4.9 4.9"/></>,
    scan: <><path d="M5 3H3v4M15 3h2v4M5 17H3v-4M15 17h2v-4"/><path d="M7 10h6"/></>,
    drive: <><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M5.5 12.5h9M6 7.5h.01M9 7.5h5"/></>,
    folder: <><path d="M2.8 6.2a1.7 1.7 0 0 1 1.7-1.7h4l1.5 1.8h5.5a1.7 1.7 0 0 1 1.7 1.7v5.8a1.7 1.7 0 0 1-1.7 1.7H4.5a1.7 1.7 0 0 1-1.7-1.7z"/></>,
    file: <><path d="M5 2.8h6l4 4v10.4H5z"/><path d="M11 2.8v4h4M7.2 11h5.6M7.2 14h4"/></>,
    search: <><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/></>,
    filter: <><path d="M3 4h14l-5.3 6.1v4.5l-3.4 1.7v-6.2z"/></>,
    info: <><circle cx="10" cy="10" r="7"/><path d="M10 9v4M10 6.5h.01"/></>,
    arrowLeft: <><path d="M12.5 5 7.5 10l5 5"/></>,
    arrowRight: <><path d="m7.5 5 5 5-5 5"/></>,
    chevronRight: <><path d="m8 5 5 5-5 5"/></>,
    close: <><path d="m6 6 8 8M14 6l-8 8"/></>,
    more: <><circle cx="5" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r=".8" fill="currentColor" stroke="none"/></>,
    sparkles: <><path d="m7 3 1.1 2.9L11 7l-2.9 1.1L7 11 5.9 8.1 3 7l2.9-1.1z"/><path d="m14 10 1 2.2 2.2 1-2.2 1L14 16.5l-1-2.3-2.2-1 2.2-1z"/></>,
    check: <><path d="m4.5 10.5 3.2 3.2 7.8-8"/></>,
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.info}
    </svg>
  );
}
