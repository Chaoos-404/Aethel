export function truncate(value, width) {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

export function scrollWindow(length, cursor, height) {
  return Math.min(
    Math.max(cursor - Math.floor(height / 2), 0),
    Math.max(length - height, 0)
  );
}
