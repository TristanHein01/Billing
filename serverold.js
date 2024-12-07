import express from 'express';
import mysql from 'mysql2';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';

// Setze den Pfad des aktuellen Verzeichnisses für ES-Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// MySQL-Verbindung
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '', // Dein MySQL Passwort
  database: 'billing', // Deine Datenbank
});

db.connect((err) => {
  if (err) {
    console.error('Fehler bei der Datenbankverbindung:', err.stack);
    return;
  }
  console.log('Mit der Datenbank verbunden.');
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Sicherstellen, dass die Verzeichnisse existieren
const ensureDirectoriesExist = () => {
  const dirs = ['public/rechnungen'];
  dirs.forEach((dir) => {
    if (!fs.existsSync(path.join(__dirname, dir))) {
      fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
    }
  });
};

app.post('/generate-all-rechnungen', async (req, res) => {
  try {
      const [kundenResult] = await db.promise().query('SELECT id FROM kunden');
      if (kundenResult.length === 0) {
          return res.status(404).send('Keine Kunden gefunden');
      }

      const downloadLinks = [];

      for (const kunde of kundenResult) {
          try {
              const [kundenData] = await db.promise().query('SELECT * FROM kunden WHERE id = ?', [kunde.id]);
              const kundeDetails = kundenData[0];

              const [positionenResult] = await db.promise().query(
                  'SELECT * FROM positions WHERE kunden_id = ? AND rechnungs_id IS NULL',
                  [kunde.id]
              );

              if (positionenResult.length === 0) {
                  console.error(`Keine offenen Positionen für Kunde ${kunde.id}`);
                  continue;
              }

              let gesamtbetrag = 0;
              let umsatzsteuer = 0;
              positionenResult.forEach((position) => {
                  const einzelpreis = parseFloat(position.einzelpreis) || 0;
                  gesamtbetrag += position.menge * einzelpreis;
                  umsatzsteuer += position.menge * einzelpreis * 0.19; // Beispiel: 19% USt
              });

              // Rechnungsnummer für den Kunden dynamisch generieren
              const rechnungsnummer = `2024-${kunde.id}`;

              // Rechnungs-PDF-Erstellung
              const invoicePath = path.join(__dirname, 'public', 'rechnungen', `rechnung_${rechnungsnummer}.pdf`);
              const doc = new PDFDocument({ margin: 50 });

              doc.pipe(fs.createWriteStream(invoicePath));

              // Kopfzeile mit Logo
              const logoPath = path.join(__dirname, 'public', 'download.png');
              if (fs.existsSync(logoPath)) {
                  doc.image(logoPath, 50, 50, { width: 100 });
              }

              // Firmeninformationen rechts oben neben dem Logo
              doc.fontSize(8);
              const companyInfo = [
                  'Streams Telecommunicationservices GmbH',
                  'Tel.: ',
                  '3400 Klosterneuburg, Wasserzeile 27',
              ];
              companyInfo.forEach((line, index) => {
                  doc.text(line, 400, 50 + index * 15, { align: 'right' });
              });

              // Kundendaten links unter dem Logo
              doc.fontSize(11)
                  .text(`${kundeDetails.name}`, 50, 150)
                  .text(`${kundeDetails.adresse}`, 50, 165);

              // Rechnungsinformationen rechts
              doc.text(`Klosterneuburg, am ${new Date().toLocaleDateString()}`, 400, 150, { align: 'right' });
              doc.text(`Re-Nr: ${rechnungsnummer}`, 400, 165, { align: 'right' });

              // Titel "Rechnung" in der Mitte
              doc.fontSize(10).text('Rechnung', { align: 'center' });
              doc.moveDown();

              // Tabelle für Positionen
              const tableTop = doc.y;

              // Spaltenüberschriften (Menge und Beschreibung entfernt)
              doc.text('Position', 50, tableTop);
              doc.text('Einzelpreis', 350, tableTop, { width: 100, align: 'right' });
              doc.text('Gesamtpreis', 450, tableTop, { width: 100, align: 'right' });

              positionenResult.forEach((position, index) => {
                  const itemTop = tableTop + 25 + index * 20;
                  const einzelpreis = parseFloat(position.einzelpreis) || 0;
                  const gesamtpreis = position.menge * einzelpreis;

                  // Position, Einzelpreis und Gesamtpreis anzeigen
                  doc.text(position.bezeichnung, 50, itemTop);
                  doc.text(`€${einzelpreis.toFixed(2)}`, 350, itemTop, { width: 100, align: 'right' });
                  doc.text(`€${gesamtpreis.toFixed(2)}`, 450, itemTop, { width: 100, align: 'right' });
              });

              // USt und Gesamtbetrag
              doc.moveDown();
              doc.text(`Umsatzsteuer (19%): €${umsatzsteuer.toFixed(2)}`, { align: 'right' });
              doc.text(`Gesamtbetrag: €${gesamtbetrag.toFixed(2)}`, { align: 'right' });

              // QR-Code am unteren Rand
              const qrData = `Rechnungsnummer: ${rechnungsnummer}\nBetrag: €${gesamtbetrag.toFixed(2)}`;
              const qrCodePath = path.join(__dirname, 'public', 'rechnungen', 'qrCode.png');
              await QRCode.toFile(qrCodePath, qrData);

              doc.image(qrCodePath, 50, doc.y + 20, { width: 150 });

              // Berechnung des Platzes am unteren Rand der Seite
              const pageHeight = doc.page.height; // Höhe der Seite
              const marginBottom = doc.page.margins.bottom; // Abstand zum unteren Rand der Seite
              const remainingHeight = pageHeight - doc.y - marginBottom;

              // Wenn noch genug Platz vorhanden ist, Text am Fuß der Seite platzieren
              if (remainingHeight >= 60) { // Genügend Platz für den Footer
                  const footerY = pageHeight - marginBottom - 60; // 60 Pixel vom unteren Rand entfernt
                  doc.fontSize(10);
                  doc.text('Firmenbuch: FN172482a, Handelsgericht Wien, UID-Nr: ATU 45642700', doc.page.margins.left, footerY, { align: 'center' });
                  doc.text('RLB NÖ-Wien, BIC: RLNWATWW, Kontonummer: AT04 3200 0000 0019 8473', doc.page.margins.left, footerY + 15, { align: 'center' });
                  //doc.text('3400 Klosterneuburg, Wasserzeile 27', doc.page.margins.left, footerY + 30, { align: 'center' });
              }

              doc.end();

              downloadLinks.push({
                  rechnungsnummer,
                  link: `/rechnungen/rechnung_${rechnungsnummer}.pdf`,
              });
          } catch (error) {
              console.error(`Fehler bei Kunde ${kunde.id}: ${error.message}`);
              continue;
          }
      }

      res.json({
          message: 'Rechnungen erfolgreich erstellt.',
          downloadLinks,
      });
  } catch (error) {
      console.error('Fehler:', error.message);
      res.status(500).send('Fehler beim Erstellen der Rechnungen');
  }
});



// Sicherstellen, dass die Verzeichnisse existieren
ensureDirectoriesExist();

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});




/// Wichtig rechnungsnummer aufsteigend machen !!!!