// TabsContent only renders true inside Tabs — full composition on purpose.
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@shieldedtech/moth-extension';

export const WithContent = () => (
  <Tabs defaultValue="shielded">
    <TabsList>
      <TabsTrigger value="shielded">Shielded</TabsTrigger>
      <TabsTrigger value="unshielded">Unshielded</TabsTrigger>
    </TabsList>
    <TabsContent value="shielded">
      <p className="m-0 pt-2 text-center text-[12.5px] text-muted-foreground">
        Private transfers with zero-knowledge proofs. Accepts NIGHT and native tokens.
      </p>
    </TabsContent>
    <TabsContent value="unshielded">
      <p className="m-0 pt-2 text-center text-[12.5px] text-muted-foreground">
        Public transfers on Midnight. Holds NIGHT and native tokens.
      </p>
    </TabsContent>
  </Tabs>
);
