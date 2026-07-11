interface HomeProps {
  onCreate: () => void;
  onJoin: () => void;
}

export function Home({ onCreate, onJoin }: HomeProps) {
  return (
    <div className="imp-center">
      <h1>IMPERIUM</h1>
      <div className="imp-subtitle">Twilight of Empires · 1400–1453</div>
      <p style={{ maxWidth: 480 }}>
        The eagles of Rome are guttering. Byzantium, the Ottoman, Venice, Genoa
        and Hungary contend for the ruins of empire. Gather your allies and seize
        the age.
      </p>
      <div className="imp-row">
        <button onClick={onCreate}>Create Game</button>
        <button className="ghost" onClick={onJoin}>
          Join Game
        </button>
      </div>
    </div>
  );
}
