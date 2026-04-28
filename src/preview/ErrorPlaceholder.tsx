export function ErrorPlaceholder({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ padding: 24, color: "#e88" }}>
      <div style={{ marginBottom: 8 }}>Couldn't read file: {message}</div>
      <button onClick={onRetry}>Retry</button>
    </div>
  );
}
