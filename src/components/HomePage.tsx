import type { RecentDocumentEntry } from '../lib/documentStore';

interface HomePageProps {
  recents: RecentDocumentEntry[];
  onCreatePart: () => void;
  onOpenDocument: (id: string) => void;
}

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

export const HomePage = ({ recents, onCreatePart, onOpenDocument }: HomePageProps) => {
  return (
    <div className="h-screen w-screen bg-zinc-100 text-zinc-900 overflow-auto">
      <div className="max-w-5xl mx-auto px-8 py-10">
        <h1 className="text-2xl font-semibold mb-2">ModernCAD</h1>
        <p className="text-sm text-zinc-600 mb-8">Create and open part documents (`.par`).</p>

        <div className="bg-white border border-zinc-300 rounded-lg p-5 mb-6">
          <button
            onClick={onCreatePart}
            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors"
          >
            New Part Document
          </button>
        </div>

        <div className="bg-white border border-zinc-300 rounded-lg p-5">
          <h2 className="text-base font-semibold mb-3">Recent Documents</h2>
          {recents.length === 0 ? (
            <p className="text-sm text-zinc-500">No recent documents yet.</p>
          ) : (
            <div className="divide-y divide-zinc-200">
              {recents.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => onOpenDocument(doc.id)}
                  className="w-full py-3 text-left hover:bg-zinc-50 transition-colors px-1"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-zinc-900">{doc.name}{doc.extension}</div>
                      <div className="text-xs text-zinc-500">Part document</div>
                    </div>
                    <div className="text-xs text-zinc-500 whitespace-nowrap">
                      {formatTimestamp(doc.updatedAt)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
