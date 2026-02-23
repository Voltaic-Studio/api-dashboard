import apis from '@/data/apis.json';

export function ApiGrid() {
  // Just show top 12 for MVP performance
  const displayApis = apis.slice(0, 12);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto px-4 mt-16 pb-20">
      {displayApis.map((api: any) => (
        <a 
          key={api.id} 
          href={api.website}
          target="_blank"
          className="group block p-6 bg-[var(--background)] rounded-2xl border border-[var(--border)] hover:border-[var(--accent)] hover:shadow-lg transition-all duration-300"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--muted)] flex items-center justify-center overflow-hidden">
              {api.logo ? (
                <img src={api.logo} alt={api.title} className="w-8 h-8 object-contain" />
              ) : (
                <span className="text-xl font-bold">{api.title[0]}</span>
              )}
            </div>
            <span className="text-[10px] font-semibold bg-[var(--muted)] px-2 py-1 rounded-full uppercase tracking-wide text-[var(--foreground)]/60">
              REST
            </span>
          </div>
          
          <h3 className="text-lg font-semibold mb-2 group-hover:text-[var(--accent)] transition-colors">
            {api.title}
          </h3>
          <p className="text-sm text-[var(--foreground)]/70 line-clamp-3 leading-relaxed">
            {api.description}
          </p>
        </a>
      ))}
    </div>
  );
}
