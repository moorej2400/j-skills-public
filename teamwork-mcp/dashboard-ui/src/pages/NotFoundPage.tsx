import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function NotFoundPage(): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Not Found</CardTitle>
        <CardDescription>This route does not exist.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">Coming soon.</CardContent>
    </Card>
  );
}
