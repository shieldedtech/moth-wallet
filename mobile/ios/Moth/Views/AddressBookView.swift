import SwiftUI

struct AddressBookView: View {
    @EnvironmentObject private var model: WalletModel
    @State private var editing: Contact?

    var body: some View {
        List {
            if model.contacts.isEmpty {
                Text("No contacts yet. Add the Midnight or Cardano addresses you send to often.").foregroundStyle(.secondary)
            }
            ForEach(model.contacts) { contact in
                Button { editing = contact } label: { ContactRow(contact: contact) }
                    .swipeActions { Button("Delete", role: .destructive) { model.deleteContact(contact) } }
            }
        }
        .navigationTitle("Address book")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { editing = Contact(name: "", address: "") } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add contact")
            }
        }
        .sheet(item: $editing) { ContactEditor(contact: $0) }
    }
}

struct ContactRow: View {
    let contact: Contact

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(contact.name).foregroundStyle(.primary)
                Text(contact.kind).font(.caption).foregroundStyle(.secondary)
            }
            Text(contact.address.prefix(22) + "…" + contact.address.suffix(8)).font(.caption.monospaced()).foregroundStyle(.secondary)
        }
    }
}

private struct ContactEditor: View {
    @EnvironmentObject private var model: WalletModel
    @Environment(\.dismiss) private var dismiss
    @State var contact: Contact

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $contact.name)
                TextField("Address", text: $contact.address, axis: .vertical)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .navigationTitle(contact.name.isEmpty ? "New contact" : contact.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        contact.address = contact.address.trimmingCharacters(in: .whitespacesAndNewlines)
                        model.saveContact(contact)
                        dismiss()
                    }
                    .disabled(contact.name.isEmpty || contact.kind == "address")
                }
            }
        }
    }
}

/// Picks a saved contact, e.g. for a send line.
struct ContactPicker: View {
    @EnvironmentObject private var model: WalletModel
    @Environment(\.dismiss) private var dismiss
    var cardano = false
    let onPick: (Contact) -> Void

    var body: some View {
        NavigationStack {
            List {
                let shown = model.contacts.filter { ($0.kind == "Cardano") == cardano }
                if shown.isEmpty {
                    Text("No matching contacts. Add them under Settings → Address book.").foregroundStyle(.secondary)
                }
                ForEach(shown) { contact in
                    Button {
                        onPick(contact)
                        dismiss()
                    } label: { ContactRow(contact: contact) }
                }
            }
            .navigationTitle("Contacts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
