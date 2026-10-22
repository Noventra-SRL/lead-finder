import { createServer, type Server } from 'node:http';
import { listenOnFetchablePort } from '../testing.ts';
import type { AddressInfo } from 'node:net';

/*
 * SOLO TEST: server HTTP locale che risponde con il protocollo dei messaggi di Anthropic, per provare l'intero
 * flusso (interfaccia → server → SDK reale) senza rete e senza costi. La risposta è deterministica e costruita solo
 * dalle prove ricevute: cita gli id presenti e propone il primo servizio del catalogo ricevuto.
 */

export async function startFakeAnthropic(port = 0): Promise<{ url: string; requests: number; close(): Promise<void> }> {
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      state.requests++;
      const body = JSON.parse(raw || '{}') as { model?: string; messages?: { content: string }[] };
      const user = body.messages?.[0]?.content ?? '';
      const reply = (output: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `msg_prova_${state.requests}`,
            type: 'message',
            role: 'assistant',
            model: body.model ?? 'modello-di-prova',
            content: [{ type: 'text', text: JSON.stringify(output) }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1800, output_tokens: 500 },
          }),
        );
      };
      // email commerciale (Fase 9): testo generico, osservazione sul sito solo se c'è un rilievo F1
      const emailData = /<dati_email>\n([\s\S]*)\n<\/dati_email>/.exec(user)?.[1];
      if (emailData) {
        const d = JSON.parse(emailData) as { prove?: { id: string }[]; catalogo_servizi_noventra?: { id: string }[] };
        const has = new Set((d.prove ?? []).map((p) => p.id));
        reply({
          subject: 'Una proposta per la presenza online della vostra attività | Noventra',
          opening:
            'Ho visto la scheda pubblica della vostra attività e credo che una presenza online curata possa aiutarvi a farvi trovare da chi cerca i vostri servizi nella vostra zona.',
          website_observation: has.has('F1')
            ? {
                text: 'Dando un’occhiata al sito ho notato alcuni aspetti tecnici che si possono migliorare senza stravolgerlo.',
                evidence_refs: ['F1'],
              }
            : null,
          relevance:
            'Noventra può seguire il progetto dall’impostazione alla messa online, scegliendo solo ciò che serve davvero alla vostra attività.',
          relevance_evidence_refs: ['B1'],
          service_ids: d.catalogo_servizi_noventra?.[0] ? [d.catalogo_servizi_noventra[0].id] : [],
          call_to_action:
            'Se vi fa piacere, possiamo sentirci per una breve chiamata conoscitiva nei prossimi giorni, quando vi è più comodo.',
          verified_facts: [{ text: 'Attività presente su OpenStreetMap', evidence_refs: ['B4'] }],
          inferences: [{ text: 'Potrebbe beneficiare di una presenza online più curata', evidence_refs: ['B1'] }],
          unknowns: ['Referente e budget non noti'],
        });
        return;
      }
      const data = JSON.parse(/<dati_azienda>\n([\s\S]*)\n<\/dati_azienda>/.exec(user)?.[1] ?? '{}') as {
        business_id?: string;
        prove?: { id: string }[];
        catalogo_servizi_noventra?: { id: string }[];
      };
      const ids = new Set((data.prove ?? []).map((p) => p.id));
      const finding = ids.has('F1');
      const comp = (score: number, refs: string[]) => ({
        score,
        explanation: 'Valutazione di prova dal server finto.',
        evidence_refs: refs,
      });
      const output = {
        business_id: data.business_id ?? '',
        summary: 'Valutazione di prova: attività con un recapito pubblico e un bisogno digitale plausibile.',
        components: {
          acquisition: comp(72, ['B3']),
          service_fit: comp(78, ['B1']),
          improvement: comp(finding ? 85 : 64, [finding ? 'F1' : 'W1']),
          attractiveness: comp(70, ['B1']),
          evidence_quality: comp(55, ['B4']),
        },
        positive_signals: [{ text: 'Recapito pubblico disponibile', evidence_refs: ['B3'] }],
        negative_signals: [],
        obstacles: [],
        recommended_service_ids: data.catalogo_servizi_noventra?.[0] ? [data.catalogo_servizi_noventra[0].id] : [],
        verified_facts: [{ text: 'Attività registrata su OpenStreetMap', evidence_refs: ['B4'] }],
        inferences: [{ text: 'Un sito curato potrebbe portare richieste', evidence_refs: ['B1'] }],
        unknowns: ['Budget e decisore non noti'],
        business_status: 'likely_active',
        confidence: { level: 'medium', explanation: 'Prove parziali.' },
        next_step: 'Telefonare per verificare il bisogno.',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `msg_prova_${state.requests}`,
          type: 'message',
          role: 'assistant',
          model: body.model ?? 'modello-di-prova',
          content: [{ type: 'text', text: JSON.stringify(output) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2500, output_tokens: 900 },
        }),
      );
    });
  });
  // porta 0 (test): una porta che fetch() accetta; porta fissa (e2e): quella richiesta
  if (port === 0) await listenOnFetchablePort(server);
  else await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get requests() {
      return state.requests;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
