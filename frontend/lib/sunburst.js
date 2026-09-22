export function groupSmallItems(
  items,
  totalRootSize,
  minRootPercent = 0.01,
  maxVisible = 5,
) {
  const valid = items
    .filter((item) => Number(item.size) > 0)
    .sort((a, b) => Number(b.size) - Number(a.size));

  const visible = [];
  let otherSize = 0;

  for (const item of valid) {
    const rootPercentage =
      totalRootSize > 0 ? Number(item.size) / totalRootSize : 0;

    if (visible.length < maxVisible && rootPercentage >= minRootPercent) {
      visible.push(item);
    } else {
      otherSize += Number(item.size) || 0;
    }
  }

  return {
    visible,
    otherSize,
  };
}
