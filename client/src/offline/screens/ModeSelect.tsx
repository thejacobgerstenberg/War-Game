/**
 * Offline mode select (spec §6): hotseat vs solo. Home.tsx styling/classes.
 */
interface ModeSelectProps {
  onHotseat: () => void;
  onSolo: () => void;
}

export function ModeSelect({ onHotseat, onSolo }: ModeSelectProps) {
  return (
    <div className="imp-center">
      <h1>IMPERIUM</h1>
      <div className="imp-subtitle">Twilight of Empires · 1400–1453 · Offline</div>
      <p style={{ maxWidth: 480 }}>
        The eagles of Rome are guttering. Byzantium, the Ottoman, Venice, Genoa
        and Hungary contend for the ruins of empire. One device, no servers —
        pass it round the table, or stand alone against the machine.
      </p>
      <div className="imp-row">
        <button onClick={onHotseat}>Hotseat (2–5 players)</button>
        <button className="ghost" onClick={onSolo}>
          Solo vs Bots
        </button>
      </div>
    </div>
  );
}
