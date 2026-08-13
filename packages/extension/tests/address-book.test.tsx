import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddressBook } from '../components/screens/AddressBook';
import { AddressPicker } from '../components/moth/address-picker';
import type { AddressBookEntry } from '../lib/background/address-book';

const entries: AddressBookEntry[] = [
  { id: '1', name: 'Alice', address: `mn_shield-addr_preprod1${'a'.repeat(30)}`, kind: 'shielded' },
  { id: '2', name: 'Bob', address: `mn_addr_preprod1${'b'.repeat(30)}`, kind: 'unshielded' },
];

describe('AddressBook screen', () => {
  it('renders the empty state before entries load', () => {
    // Static render runs no effects, so useAddressBook stays empty here.
    const html = renderToStaticMarkup(<AddressBook onBack={() => {}} />);
    expect(html).toContain('No saved addresses yet');
    expect(html).toContain('+ Add address');
  });
});

describe('AddressPicker', () => {
  it('offers the address book only when a matching-kind entry exists', () => {
    const withMatch = renderToStaticMarkup(
      <AddressPicker kind="shielded" value="" onChange={() => {}} entries={entries} />,
    );
    expect(withMatch).toContain('Address book');

    const noMatch = renderToStaticMarkup(
      <AddressPicker kind="dust" value="" onChange={() => {}} entries={entries} />,
    );
    expect(noMatch).not.toContain('Address book');
  });

  it('shows the matched entry name when the value is a saved address', () => {
    const html = renderToStaticMarkup(
      <AddressPicker kind="unshielded" value={entries[1].address} onChange={() => {}} entries={entries} />,
    );
    expect(html).toContain('Bob');
  });
});
