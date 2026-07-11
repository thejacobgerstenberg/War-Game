interface HomeProps {
  onCreate: () => void;
  onJoin: () => void;
}

// Copy sources (contract): design/mockups/home.html (path labels, rubrics)
// and lore/ui-text.md §1 Main Menu (title tagline).
export function Home({ onCreate, onJoin }: HomeProps) {
  return (
    <div className="imp-center">
      <h1>IMPERIUM</h1>
      <div className="imp-subtitle">— Twilight of Empires —</div>
      <p style={{ maxWidth: 480, fontStyle: "italic" }}>
        Five crowns. One dying empire. The years run out at the Golden Horn.
      </p>
      <p style={{ maxWidth: 480 }}>
        Anno Domini 1400–1453 · Five powers, one failing age — and every road
        ends at the City.
      </p>
      <div className="imp-row">
        <button onClick={onCreate}>Convene a Game</button>
        <button className="ghost" onClick={onJoin}>
          Answer a Summons
        </button>
      </div>
    </div>
  );
}
