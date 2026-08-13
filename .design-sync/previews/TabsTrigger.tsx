// TabsTrigger only renders true inside Tabs — full composition on purpose.
import { Tabs, TabsList, TabsTrigger } from '@shieldedtech/moth-extension';

export const ActiveAndInactive = () => (
  <Tabs defaultValue="shielded">
    <TabsList>
      <TabsTrigger value="shielded">Shielded</TabsTrigger>
      <TabsTrigger value="unshielded">Unshielded</TabsTrigger>
    </TabsList>
  </Tabs>
);
