export default function StatusIndicator({ title, description }) {
  return (
    <div className="dl-sidebar-footer">
      <span className="dl-status-dot" aria-hidden="true" />
      <div>
        <div className="dl-status-title">{title}</div>
        <div className="dl-status-text">{description}</div>
      </div>
    </div>
  );
}
