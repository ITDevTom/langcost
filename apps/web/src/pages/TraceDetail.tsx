import { TraceDetailContent } from "../components/trace/TraceDetailContent";

interface TraceDetailProps {
  traceId: string;
  refreshToken: number;
  onBack: () => void;
}

export function TraceDetail({ traceId, refreshToken, onBack }: TraceDetailProps) {
  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-6">
      <button type="button" onClick={onBack} className="button-ghost w-fit">
        ← Back to Traces
      </button>

      <TraceDetailContent traceId={traceId} refreshToken={refreshToken} />
    </div>
  );
}
