export default function Detail({ label, value }) {
  return (
    <div>
      <div className="dl-detail-label">{label}</div>
      <div className="dl-detail-value">{value || "-"}</div>
    </div>
  );
}
