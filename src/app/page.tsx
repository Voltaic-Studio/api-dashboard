import { Navbar } from '@/components/ui/navbar';
import { SearchBar } from '@/components/ui/search-bar';
import { ApiGrid } from '@/components/ui/api-grid';

export default function Home() {
  return (
    <main className="min-h-screen pt-32">
      <Navbar />
      
      <section className="text-center px-4 mb-20 space-y-6">
        <h1 className="text-5xl md:text-7xl font-bold tracking-tighter text-balance">
          APIs. <span className="text-[var(--accent)]">Refined.</span>
        </h1>
        <p className="text-xl md:text-2xl text-[var(--foreground)]/60 font-medium max-w-2xl mx-auto leading-relaxed">
          The definitive marketplace for developer tools. <br/>
          Discover, test, and integrate in seconds.
        </p>
        
        <div className="mt-10">
          <SearchBar />
        </div>
      </section>

      <ApiGrid />
    </main>
  );
}
