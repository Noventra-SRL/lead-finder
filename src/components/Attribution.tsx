/** Attribuzione obbligatoria dei dati OpenStreetMap (licenza ODbL) e del dataset ISTAT dei comuni (CC BY 4.0). */
export function Attribution({ geo = false }: { geo?: boolean }) {
  return (
    <p className="attribution">
      Dati delle attività:{' '}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
        © OpenStreetMap contributors
      </a>
      , licenza{' '}
      <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">
        ODbL 1.0
      </a>
      .
      {geo && (
        <>
          {' '}
          Codici e denominazioni dei comuni: ISTAT, licenza{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/deed.it" target="_blank" rel="noopener noreferrer">
            CC BY 4.0
          </a>{' '}
          (colonne selezionate).
        </>
      )}
    </p>
  );
}
